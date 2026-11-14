"""
Tests for #673: Django admin mutations on Card/Column must broadcast via
broadcast_board_event(), deferred through transaction.on_commit(), so clients
viewing the affected board see admin edits in real time.

#1241 extends this same coverage to Swimlane, Label, Board, BoardMembership,
CardComment, and CardChecklist — the #673 fix only covered Card and Column;
the other board-scoped models registered in boards/admin.py were still plain
admin.site.register(...) with no broadcast override, so an admin edit/delete
on them left connected WebSocket clients silently stale, exactly the failure
mode #673's own CardAdmin docstring warns about.

Board additionally needs a *group*-channel broadcast alongside the board
channel — GroupDetail.tsx's dashboard/boards-list view subscribes to
board.created/updated/deleted only on the group socket. BoardAdminBroadcastTests
covers that half explicitly; it does not apply to Swimlane/Label/
BoardMembership, whose REST viewsets never call broadcast_group_event either.
"""
from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.test import RequestFactory, TestCase
from django.urls import reverse

from accounts.models import User
from boards.admin import (
    BoardAdmin, BoardMembershipAdmin, CardAttachmentAdmin, CardChecklistAdmin, CardCommentAdmin,
    CardAdmin, ColumnAdmin, LabelAdmin, SwimlaneAdmin,
)
from boards.models import (
    Board, BoardEvent, BoardMembership, Card, CardAttachment, CardChecklist, CardComment,
    Column, Label, Swimlane,
)
from groups.models import Group


class _DummyForm:
    """Minimal stand-in for a bound ModelForm: it carries the ``fields``,
    ``is_bound`` and ``changed_data`` a real form has, so BoardAdmin's merge of
    non-form fields from the locked row runs in these tests (BoardMembershipAdmin
    runs the same merge). It is not a ``RowVersionFormMixin`` form, so the
    rendered-state check is skipped. The other admins' ``save_model`` ignores
    the form."""

    fields = {"name": None}
    is_bound = True
    changed_data = ["name"]


def _make_request(user):
    request = RequestFactory().post("/admin/")
    request.user = user
    return request


class CardAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin", password="p", email="a@x")
        self.board = Board.objects.create(name="Admin Test Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.column = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.admin = CardAdmin(Card, AdminSite())

    def _new_card(self):
        return Card(
            board=self.board,
            column=self.column,
            swimlane=self.swimlane,
            title="From admin",
            created_by=self.admin_user,
            position=0,
        )

    def test_save_model_on_create_broadcasts_card_created_after_commit(self):
        request = _make_request(self.admin_user)
        card = self._new_card()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, card, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "card.created")
            self.assertEqual(payload["uid"], card.uid)

    def test_save_model_on_update_broadcasts_card_updated(self):
        card = self._new_card()
        card.save()
        request = _make_request(self.admin_user)
        card.title = "Edited in admin"
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, card, _DummyForm(), change=True)
            mock_broadcast.assert_called_once()
            _, event_type, _ = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "card.updated")

    def test_save_model_does_not_broadcast_before_commit(self):
        request = _make_request(self.admin_user)
        card = self._new_card()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.admin.save_model(request, card, _DummyForm(), change=False)
                mock_broadcast.assert_not_called()

    def test_delete_model_broadcasts_card_deleted_with_uid(self):
        card = self._new_card()
        card.save()
        card_uid = card.uid
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, card)
            # event_id is the additive #1114 field — assert the frame carries the
            # id of the feed row the same write appended, not just that it is present.
            mock_broadcast.assert_called_once_with(
                self.board.id, "card.deleted", {"card_uid": card_uid},
                event_id=BoardEvent.objects.get(event="card.deleted").pk,
                actor_id=BoardEvent.objects.get(event="card.deleted").actor_id,
            )

    def test_delete_queryset_broadcasts_once_per_card(self):
        c1, c2 = self._new_card(), self._new_card()
        c1.title = "One"
        c1.save()
        c2.title = "Two"
        c2.save()
        uids = {c1.uid, c2.uid}
        request = _make_request(self.admin_user)
        qs = Card.objects.filter(pk__in=[c1.pk, c2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            self.assertEqual(mock_broadcast.call_count, 2)
            emitted = {call.args[2]["card_uid"] for call in mock_broadcast.call_args_list}
            self.assertEqual(emitted, uids)


class ColumnAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin2", password="p", email="b@x")
        self.board = Board.objects.create(name="Admin Column Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.admin = ColumnAdmin(Column, AdminSite())

    def _new_column(self, position=0, name="New Col"):
        return Column(board=self.board, name=name, position=position, allow_card_creation=True)

    def test_save_model_on_create_broadcasts_column_created(self):
        request = _make_request(self.admin_user)
        col = self._new_column()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, col, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "column.created")
            self.assertEqual(payload["uid"], col.uid)

    def test_save_model_on_update_broadcasts_column_updated(self):
        col = self._new_column()
        col.save()
        col.name = "Edited"
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, col, _DummyForm(), change=True)
            mock_broadcast.assert_called_once()
            _, event_type, _ = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "column.updated")

    def test_delete_model_broadcasts_column_deleted_with_uid(self):
        col = self._new_column()
        col.save()
        col_uid = col.uid
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, col)
            mock_broadcast.assert_called_once_with(
                self.board.id, "column.deleted", {"column_uid": col_uid},
                event_id=BoardEvent.objects.get(event="column.deleted").pk,
                actor_id=BoardEvent.objects.get(event="column.deleted").actor_id,
            )

    def test_delete_queryset_broadcasts_once_per_column(self):
        c1, c2 = self._new_column(position=0, name="A"), self._new_column(position=1, name="B")
        c1.save()
        c2.save()
        uids = {c1.uid, c2.uid}
        request = _make_request(self.admin_user)
        qs = Column.objects.filter(pk__in=[c1.pk, c2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            self.assertEqual(mock_broadcast.call_count, 2)
            emitted = {call.args[2]["column_uid"] for call in mock_broadcast.call_args_list}
            self.assertEqual(emitted, uids)


class SwimlaneAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin3", password="p", email="c@x")
        self.board = Board.objects.create(name="Admin Swimlane Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.admin = SwimlaneAdmin(Swimlane, AdminSite())

    def _new_swimlane(self, name="New Lane", position=0):
        return Swimlane(board=self.board, name=name, position=position)

    def test_save_model_on_create_broadcasts_swimlane_created(self):
        request = _make_request(self.admin_user)
        lane = self._new_swimlane()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, lane, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "swimlane.created")
            self.assertEqual(payload["uid"], lane.uid)
            # The public serializer must never leak admin-only PII fields
            # over the wire (contact_email, notes) — see SwimlaneAdmin's
            # _payload docstring.
            self.assertNotIn("contact_email", payload)
            self.assertNotIn("notes", payload)

    def test_save_model_on_update_broadcasts_swimlane_updated(self):
        lane = self._new_swimlane()
        lane.save()
        request = _make_request(self.admin_user)
        lane.name = "Edited Lane"
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, lane, _DummyForm(), change=True)
            mock_broadcast.assert_called_once()
            _, event_type, _ = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "swimlane.updated")

    def test_delete_model_broadcasts_swimlane_deleted_with_uid(self):
        lane = self._new_swimlane()
        lane.save()
        lane_uid = lane.uid
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, lane)
            mock_broadcast.assert_called_once_with(
                self.board.id, "swimlane.deleted", {"swimlane_uid": lane_uid},
                event_id=BoardEvent.objects.get(event="swimlane.deleted").pk,
                actor_id=BoardEvent.objects.get(event="swimlane.deleted").actor_id,
            )

    def test_delete_queryset_broadcasts_once_per_swimlane(self):
        l1, l2 = self._new_swimlane("A", 0), self._new_swimlane("B", 1)
        l1.save()
        l2.save()
        uids = {l1.uid, l2.uid}
        request = _make_request(self.admin_user)
        qs = Swimlane.objects.filter(pk__in=[l1.pk, l2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            self.assertEqual(mock_broadcast.call_count, 2)
            emitted = {call.args[2]["swimlane_uid"] for call in mock_broadcast.call_args_list}
            self.assertEqual(emitted, uids)


class LabelAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin4", password="p", email="d@x")
        self.board = Board.objects.create(name="Admin Label Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.admin = LabelAdmin(Label, AdminSite())

    def _new_label(self, name="New Label"):
        return Label(board=self.board, name=name, color="#ff0000")

    def test_save_model_on_create_broadcasts_label_created(self):
        request = _make_request(self.admin_user)
        label = self._new_label()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, label, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "label.created")
            self.assertEqual(payload["uid"], label.uid)

    def test_save_model_on_update_broadcasts_label_updated(self):
        label = self._new_label()
        label.save()
        request = _make_request(self.admin_user)
        label.name = "Edited Label"
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, label, _DummyForm(), change=True)
            mock_broadcast.assert_called_once()
            _, event_type, _ = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "label.updated")

    def test_delete_model_broadcasts_label_deleted_with_uid(self):
        label = self._new_label()
        label.save()
        label_uid = label.uid
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, label)
            mock_broadcast.assert_called_once_with(
                self.board.id, "label.deleted", {"label_uid": label_uid},
                event_id=BoardEvent.objects.get(event="label.deleted").pk,
                actor_id=BoardEvent.objects.get(event="label.deleted").actor_id,
            )

    def test_delete_queryset_broadcasts_once_per_label(self):
        l1, l2 = self._new_label("A"), self._new_label("B")
        l1.save()
        l2.save()
        uids = {l1.uid, l2.uid}
        request = _make_request(self.admin_user)
        qs = Label.objects.filter(pk__in=[l1.pk, l2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            self.assertEqual(mock_broadcast.call_count, 2)
            emitted = {call.args[2]["label_uid"] for call in mock_broadcast.call_args_list}
            self.assertEqual(emitted, uids)


class BoardAdminBroadcastTests(TestCase):
    """Board is admin's one dual-broadcast model — see BoardAdmin's docstring.

    GroupDetail.tsx's dashboard/boards-list view listens for
    board.created/updated/deleted exclusively on the group socket, so every
    save/delete here must fire on BOTH boards.broadcast.broadcast_board_event
    (board channel) and the group channel (only when the board actually
    belongs to a group): boards.admin._broadcast_group_event on create and
    delete, and, on a change, the group-move helper shared with
    BoardViewSet.perform_update/move_group, which sends through
    boards.views.boards._broadcast_group_event (#1684).
    """

    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin5", password="p", email="e@x")
        self.group = Group.objects.create(name="Admin Test Group", owner=self.admin_user)
        self.admin = BoardAdmin(Board, AdminSite())

    def test_save_model_on_create_broadcasts_board_created(self):
        request = _make_request(self.admin_user)
        board = Board(name="Admin Created Board", owner=self.admin_user, group=self.group)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast, \
             patch("boards.admin._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, board, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, board.id)
            self.assertEqual(event_type, "board.created")
            self.assertEqual(payload["uid"], board.uid)
            mock_group.assert_called_once_with(
                self.group.id, "board.created", payload, actor_id=self.admin_user.pk,
            )
            self.assertEqual(mock_broadcast.call_args.kwargs["actor_id"], self.admin_user.pk)

    def test_save_model_on_update_broadcasts_board_updated(self):
        board = Board.objects.create(name="Admin Board", owner=self.admin_user, group=self.group)
        request = _make_request(self.admin_user)
        board.name = "Renamed via admin"
        # A field the form does not carry, changed after ``board`` was read.
        Board.objects.filter(pk=board.pk).update(card_density="compact")
        # A change's group sends go through the shared group-move helper in
        # boards.views.boards (#1684).
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, board, _DummyForm(), change=True)
            mock_broadcast.assert_called_once()
            _, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "board.updated")
            mock_group.assert_called_once_with(
                self.group.id, "board.updated", payload, actor_id=self.admin_user.pk,
            )
            self.assertEqual(mock_broadcast.call_args.kwargs["actor_id"], self.admin_user.pk)
        # The merge ran: the changed form field was saved and the rest of the
        # row is the locked row's.
        board.refresh_from_db()
        self.assertEqual(board.name, "Renamed via admin")
        self.assertEqual(board.group_id, self.group.id)
        self.assertEqual(board.card_density, "compact")

    def test_delete_model_broadcasts_board_deleted_with_uid(self):
        board = Board.objects.create(name="Admin Board To Delete", owner=self.admin_user, group=self.group)
        board_id = board.id
        board_uid = board.uid
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast, \
             patch("boards.admin._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, board)
            # board.delete() clears the instance's pk, so the expected id is
            # captured beforehand — same reason CardAdmin/ColumnAdmin's own
            # delete tests capture uid before calling delete_model.
            mock_broadcast.assert_called_once_with(
                board_id, "board.deleted", {"board_uid": board_uid},
                event_id=BoardEvent.objects.get(event="board.deleted").pk,
                actor_id=BoardEvent.objects.get(event="board.deleted").actor_id,
            )
            mock_group.assert_called_once_with(
                self.group.id, "board.deleted", {"board_uid": board_uid}, actor_id=self.admin_user.pk,
            )

    def test_save_model_without_group_does_not_broadcast_group_event(self):
        """A personal (no-group) board must not fire a group-channel broadcast."""
        request = _make_request(self.admin_user)
        board = Board(name="Solo Admin Board", owner=self.admin_user)
        with patch("boards.broadcast.broadcast_board_event"), \
             patch("boards.admin._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, board, _DummyForm(), change=False)
            mock_group.assert_not_called()

    def test_delete_queryset_broadcasts_group_event_once_per_board(self):
        b1 = Board.objects.create(name="Bulk A", owner=self.admin_user, group=self.group)
        b2 = Board.objects.create(name="Bulk B", owner=self.admin_user, group=self.group)
        request = _make_request(self.admin_user)
        qs = Board.objects.filter(pk__in=[b1.pk, b2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast, \
             patch("boards.admin._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            self.assertEqual(mock_broadcast.call_count, 2)
            self.assertEqual(mock_group.call_count, 2)
            emitted = {call.args[0] for call in mock_group.call_args_list}
            self.assertEqual(emitted, {self.group.id})


class BoardAdminGroupChangeTests(TestCase):
    """An admin change of ``group`` is a group move to group subscribers, as a
    REST PATCH or move-group is (#1684): board.deleted to the group the board
    left, board.created to the one it joined, board.updated on the board
    channel either way."""

    class _GroupForm(_DummyForm):
        fields = {"name": None, "group": None}
        changed_data = ["group"]

    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin1684", password="p", email="h@x")
        self.old = Group.objects.create(name="Old 1684", owner=self.admin_user)
        self.new = Group.objects.create(name="New 1684", owner=self.admin_user)
        self.admin = BoardAdmin(Board, AdminSite())

    def _save(self, board, group, form=None):
        board.group = group
        with patch("boards.broadcast.broadcast_board_event") as mock_board, \
             patch("boards.views.boards._broadcast_group_event") as mock_group, \
             patch("boards.admin._broadcast_group_event") as mock_admin_group:
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                self.admin.save_model(
                    _make_request(self.admin_user), board, form or self._GroupForm(), change=True,
                )
        # Every group send on a change goes through the shared helper.
        mock_admin_group.assert_not_called()
        self.assertEqual(len(callbacks), 1)
        self.assertEqual([c.args[1] for c in mock_board.call_args_list], ["board.updated"])
        payload = mock_board.call_args.args[2]
        return [c.args for c in mock_group.call_args_list], payload

    def test_group_a_to_b(self):
        board = Board.objects.create(name="M", owner=self.admin_user, group=self.old)
        calls, payload = self._save(board, self.new)
        self.assertEqual(calls, [
            (self.old.id, "board.deleted", {"board_uid": str(board.uid), "board_id": board.id}),
            (self.new.id, "board.created", payload),
        ])
        board.refresh_from_db()
        self.assertEqual(board.group_id, self.new.id)

    def test_group_a_to_none(self):
        board = Board.objects.create(name="M", owner=self.admin_user, group=self.old)
        calls, _ = self._save(board, None)
        self.assertEqual(calls, [
            (self.old.id, "board.deleted", {"board_uid": str(board.uid), "board_id": board.id}),
        ])

    def test_none_to_group_b(self):
        board = Board.objects.create(name="M", owner=self.admin_user)
        calls, payload = self._save(board, self.new)
        self.assertEqual(calls, [(self.new.id, "board.created", payload)])

    def test_unchanged_group_sends_board_updated_only(self):
        board = Board.objects.create(name="M", owner=self.admin_user, group=self.old)
        board.name = "Renamed"
        calls, payload = self._save(board, self.old, form=_DummyForm())
        self.assertEqual(calls, [(self.old.id, "board.updated", payload)])

    def test_old_group_is_read_from_the_stored_row(self):
        """The group the board actually left is the stored one, not the
        instance's earlier read: a move committed after ``board`` was read
        must be the one told the board left."""
        board = Board.objects.create(name="M", owner=self.admin_user, group=self.old)
        middle = Group.objects.create(name="Middle 1684", owner=self.admin_user)
        Board.objects.filter(pk=board.pk).update(group=middle)
        calls, _ = self._save(board, self.new)
        self.assertEqual([c[:2] for c in calls], [
            (middle.id, "board.deleted"), (self.new.id, "board.created"),
        ])


class BoardMembershipAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin6", password="p", email="f@x")
        self.member_user = User.objects.create_user(username="member6", password="p", email="g@x")
        self.board = Board.objects.create(name="Admin Membership Board", owner=self.admin_user)
        self.admin = BoardMembershipAdmin(BoardMembership, AdminSite())

    def test_save_model_on_create_broadcasts_member_added(self):
        request = _make_request(self.admin_user)
        membership = BoardMembership(
            board=self.board, user=self.member_user, role=BoardMembership.Role.MEMBER
        )
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, membership, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "member.added")
            self.assertEqual(payload["user"]["id"], self.member_user.id)

    def test_save_model_on_update_broadcasts_member_updated(self):
        membership = BoardMembership.objects.create(
            board=self.board, user=self.member_user, role=BoardMembership.Role.MEMBER
        )
        request = _make_request(self.admin_user)
        membership.role = BoardMembership.Role.ADMIN
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, membership, _DummyForm(), change=True)
            mock_broadcast.assert_called_once()
            _, event_type, _ = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "member.updated")

    def test_delete_model_broadcasts_member_removed_with_user_id(self):
        membership = BoardMembership.objects.create(
            board=self.board, user=self.member_user, role=BoardMembership.Role.MEMBER
        )
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, membership)
            mock_broadcast.assert_called_once_with(
                self.board.id, "member.removed", {"user_id": self.member_user.id},
                event_id=BoardEvent.objects.get(event="member.removed").pk,
                actor_id=BoardEvent.objects.get(event="member.removed").actor_id,
            )

    def test_delete_queryset_broadcasts_once_per_membership(self):
        other_user = User.objects.create_user(username="member6b", password="p", email="g2@x")
        m1 = BoardMembership.objects.create(
            board=self.board, user=self.member_user, role=BoardMembership.Role.MEMBER
        )
        m2 = BoardMembership.objects.create(
            board=self.board, user=other_user, role=BoardMembership.Role.MEMBER
        )
        user_ids = {self.member_user.id, other_user.id}
        request = _make_request(self.admin_user)
        qs = BoardMembership.objects.filter(pk__in=[m1.pk, m2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            self.assertEqual(mock_broadcast.call_count, 2)
            emitted = {call.args[2]["user_id"] for call in mock_broadcast.call_args_list}
            self.assertEqual(emitted, user_ids)


class CardCommentAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin7", password="p", email="h@x")
        self.board = Board.objects.create(name="Admin Comment Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.column = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Commented card", created_by=self.admin_user, position=0,
        )
        self.admin = CardCommentAdmin(CardComment, AdminSite())

    def test_save_model_on_create_broadcasts_card_updated(self):
        request = _make_request(self.admin_user)
        comment = CardComment(card=self.card, author=self.admin_user, body="From admin")
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, comment, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            # No dedicated comment.* event — CardSerializer carries no nested
            # comment list (comments are fetched via their own endpoint), so
            # admin mutations re-broadcast the parent card's card.updated,
            # matching CardViewSet.comments()'s own broadcast.
            self.assertEqual(event_type, "card.updated")
            self.assertEqual(payload["uid"], self.card.uid)

    def test_delete_model_broadcasts_card_updated(self):
        comment = CardComment.objects.create(card=self.card, author=self.admin_user, body="Bye")
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, comment)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "card.updated")
            self.assertEqual(payload["uid"], self.card.uid)
            self.assertFalse(CardComment.objects.filter(pk=comment.pk).exists())

    def test_delete_queryset_broadcasts_once_per_card_not_once_per_comment(self):
        c1 = CardComment.objects.create(card=self.card, author=self.admin_user, body="One")
        c2 = CardComment.objects.create(card=self.card, author=self.admin_user, body="Two")
        request = _make_request(self.admin_user)
        qs = CardComment.objects.filter(pk__in=[c1.pk, c2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            # Both comments belong to the same card — one broadcast, not two.
            mock_broadcast.assert_called_once()
            _, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "card.updated")
            self.assertEqual(payload["uid"], self.card.uid)
            self.assertEqual(CardComment.objects.filter(card=self.card).count(), 0)


class CardChecklistAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin8", password="p", email="i@x")
        self.board = Board.objects.create(name="Admin Checklist Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.column = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Checklist card", created_by=self.admin_user, position=0,
        )
        self.admin = CardChecklistAdmin(CardChecklist, AdminSite())

    def test_save_model_on_create_broadcasts_card_updated_with_new_total(self):
        request = _make_request(self.admin_user)
        item = CardChecklist(card=self.card, text="From admin", position=0)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, item, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            # No dedicated checklist.* event — CardSerializer only exposes
            # checklist_total/checklist_done summary counts (the items
            # themselves come from their own endpoint), so admin mutations
            # re-broadcast the parent card's card.updated, matching
            # CardViewSet.checklist()'s own broadcast.
            self.assertEqual(event_type, "card.updated")
            self.assertEqual(payload["uid"], self.card.uid)
            self.assertEqual(payload["checklist_total"], 1)

    def test_delete_model_broadcasts_card_updated_with_decremented_total(self):
        item = CardChecklist.objects.create(card=self.card, text="Bye", position=0)
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, item)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "card.updated")
            self.assertEqual(payload["checklist_total"], 0)
            self.assertFalse(CardChecklist.objects.filter(pk=item.pk).exists())


class CardAttachmentAdminBroadcastTests(TestCase):
    """CardAttachment's admin re-broadcasts the parent card, like comments and checklists (#1744)."""

    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin_att", password="p", email="att@x")
        self.board = Board.objects.create(name="Admin Attachment Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        column = Column.objects.create(board=self.board, name="Backlog", position=0)
        swimlane = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = Card.objects.create(
            board=self.board, column=column, swimlane=swimlane,
            title="Attachment card", created_by=self.admin_user, position=0,
        )
        self.admin = CardAttachmentAdmin(CardAttachment, AdminSite())

    def _attachment(self, name="a.txt"):
        from django.core.files.base import ContentFile

        att = CardAttachment(card=self.card, filename=name, size=1, uploaded_by=self.admin_user)
        att.file.save(name, ContentFile(b"x"), save=False)
        att.save()
        return att

    def test_save_model_on_create_broadcasts_card_updated(self):
        from django.core.files.base import ContentFile

        att = CardAttachment(card=self.card, filename="n.txt", size=1, uploaded_by=self.admin_user)
        att.file.save("n.txt", ContentFile(b"x"), save=False)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(_make_request(self.admin_user), att, _DummyForm(), change=False)
        mock_broadcast.assert_called_once()
        board_id, event_type, payload = mock_broadcast.call_args[0]
        self.assertEqual((board_id, event_type), (self.board.id, "card.updated"))
        self.assertEqual(payload["attachment_count"], 1)
        att.file.delete(save=False)

    def test_delete_model_broadcasts_card_updated_with_decremented_count(self):
        att = self._attachment()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(_make_request(self.admin_user), att)
        mock_broadcast.assert_called_once()
        board_id, event_type, payload = mock_broadcast.call_args[0]
        self.assertEqual((board_id, event_type), (self.board.id, "card.updated"))
        self.assertEqual(payload["attachment_count"], 0)

    def test_delete_queryset_broadcasts_once_per_card(self):
        self._attachment("a.txt")
        self._attachment("b.txt")
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(
                    _make_request(self.admin_user), CardAttachment.objects.filter(card=self.card)
                )
        mock_broadcast.assert_called_once()
        self.assertEqual(mock_broadcast.call_args[0][2]["attachment_count"], 0)

    def test_card_is_read_only_on_change(self):
        att = self._attachment()
        request = _make_request(self.admin_user)
        self.assertIn("card", self.admin.get_readonly_fields(request, att))
        self.assertNotIn("card", self.admin.get_readonly_fields(request, None))
        att.file.delete(save=False)


class CardChildParentFixedOnChangeTests(TestCase):
    """The parent card of a comment or checklist item is read-only on change."""

    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin9", password="p", email="j@x")
        self.board = Board.objects.create(name="Admin Parent Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.column = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="First card", created_by=self.admin_user, position=0,
        )
        self.other = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Second card", created_by=self.admin_user, position=1,
        )
        self.client.force_login(self.admin_user)

    def test_card_is_read_only_on_change_and_editable_on_add(self):
        request = _make_request(self.admin_user)
        for admin_cls, model, obj in (
            (CardCommentAdmin, CardComment,
             CardComment.objects.create(card=self.card, author=self.admin_user, body="x")),
            (CardChecklistAdmin, CardChecklist,
             CardChecklist.objects.create(card=self.card, text="x", position=0)),
        ):
            ma = admin_cls(model, AdminSite())
            self.assertIn("card", ma.get_readonly_fields(request, obj))
            self.assertNotIn("card", ma.get_readonly_fields(request, None))

    def test_save_model_keeps_stored_card_on_change(self):
        item = CardChecklist.objects.create(card=self.card, text="x", position=0)
        item.card = self.other
        admin = CardChecklistAdmin(CardChecklist, AdminSite())
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                admin.save_model(_make_request(self.admin_user), item, _DummyForm(), change=True)
        item.refresh_from_db()
        self.assertEqual(item.card_id, self.card.id)
        mock_broadcast.assert_called_once()
        self.assertEqual(mock_broadcast.call_args[0][2]["uid"], self.card.uid)

    def test_change_view_post_with_different_card_does_not_move_comment(self):
        comment = CardComment.objects.create(card=self.card, author=self.admin_user, body="Old")
        url = reverse("admin:boards_cardcomment_change", args=[comment.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    url, {"card": self.other.pk, "author": self.admin_user.pk, "body": "New"}
                )
        self.assertEqual(resp.status_code, 302)
        comment.refresh_from_db()
        self.assertEqual(comment.card_id, self.card.id)
        self.assertEqual(comment.body, "New")
        uids = [c[0][2]["uid"] for c in mock_broadcast.call_args_list]
        self.assertEqual(uids, [self.card.uid])

    def test_change_view_post_with_different_card_does_not_move_checklist_item(self):
        item = CardChecklist.objects.create(card=self.card, text="Old", position=0)
        url = reverse("admin:boards_cardchecklist_change", args=[item.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    url, {"card": self.other.pk, "text": "New", "position": 0}
                )
        self.assertEqual(resp.status_code, 302)
        item.refresh_from_db()
        self.assertEqual(item.card_id, self.card.id)
        self.assertEqual(item.text, "New")
        uids = [c[0][2]["uid"] for c in mock_broadcast.call_args_list]
        self.assertEqual(uids, [self.card.uid])
