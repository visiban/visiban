"""Dimension plans and the dimension pin pool (#1922)."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards import broadcast as _broadcast
from boards.models import BoardMembership, Card, CardDimensionPlan, Column, CustomFieldDefinition, Swimlane
from boards.serializers import DimensionPlanWriteSerializer
from boards.tests.conftest import _make_board


class _Base(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()
        self.admin = User.objects.create_user(username="admin1922", password="pass")
        self.client.force_authenticate(self.admin)
        self.board = _make_board(self.admin)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.lane, title="C",
            created_by=self.admin, position=0,
        )
        self.dim = CustomFieldDefinition.objects.create(
            board=self.board, name="Security", field_type="dropdown",
            choices_json=["Pending", "Approved"], is_dimension=True,
            choice_resolutions={"Approved": "satisfied"}, position=0,
        )

    def member(self, username, role):
        user = User.objects.create_user(username=username, password="pass")
        BoardMembership.objects.create(board=self.board, user=user, role=role)
        return user

    def url(self, card=None, field=None):
        card = card or self.card
        field_pk = field.pk if field is not None else self.dim.pk
        return f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/dimension-plans/{field_pk}/"


class DimensionPlanWriteTests(_Base):
    def test_put_creates_plan_and_returns_it_on_the_card(self):
        owner = self.member("owner1922", BoardMembership.Role.MEMBER)
        body = {"owner_id": owner.pk, "next_action": "  Book review  ", "target_date": "2026-12-01"}
        resp = self.client.put(self.url(), body, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        plans = resp.data["dimension_plans"]
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]["field_id"], self.dim.pk)
        self.assertEqual(plans[0]["owner"]["id"], owner.pk)
        self.assertEqual(plans[0]["next_action"], "Book review")
        self.assertEqual(plans[0]["target_date"], "2026-12-01")
        row = CardDimensionPlan.objects.get()
        self.assertEqual(row.updated_by, self.admin)

    def test_put_is_a_full_replace_and_empty_deletes(self):
        self.client.put(self.url(), {"next_action": "A", "target_date": "2026-12-01"}, format="json")
        resp = self.client.put(self.url(), {"next_action": "B"}, format="json")
        self.assertIsNone(resp.data["dimension_plans"][0]["target_date"])
        resp = self.client.put(self.url(), {}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["dimension_plans"], [])
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_put_bumps_version_and_broadcasts_card_updated_after_commit(self):
        before = self.card.version
        with patch("boards.services.cards._broadcast.record_board_event") as record, \
                self.captureOnCommitCallbacks(execute=True) as callbacks:
            resp = self.client.put(self.url(), {"next_action": "Go"}, format="json")
        self.assertEqual(resp.data["version"], before + 1)
        self.assertEqual(record.call_args.args[1], _broadcast.EVT_CARD_UPDATED)
        self.assertEqual(record.call_args.args[2]["dimension_plans"][0]["next_action"], "Go")
        self.assertTrue(callbacks)

    def test_non_dimension_field_is_404(self):
        text = CustomFieldDefinition.objects.create(board=self.board, name="Notes", field_type="text", position=1)
        resp = self.client.put(self.url(field=text), {"next_action": "x"}, format="json")
        self.assertEqual(resp.status_code, 404)

    def test_other_boards_dimension_is_404(self):
        other = _make_board(self.admin, name="Other")
        foreign = CustomFieldDefinition.objects.create(
            board=other, name="Security", field_type="dropdown", choices_json=["A"], is_dimension=True,
        )
        resp = self.client.put(self.url(field=foreign), {"next_action": "x"}, format="json")
        self.assertEqual(resp.status_code, 404)
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_archived_card_is_404(self):
        from django.utils import timezone
        Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
        resp = self.client.put(self.url(), {"next_action": "x"}, format="json")
        self.assertEqual(resp.status_code, 404)

    def test_viewer_is_403(self):
        viewer = self.member("viewer1922", BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        resp = self.client.put(self.url(), {"next_action": "x"}, format="json")
        self.assertEqual(resp.status_code, 403)

    def test_member_cannot_plan_another_users_card(self):
        member = self.member("member1922", BoardMembership.Role.MEMBER)
        self.client.force_authenticate(member)
        resp = self.client.put(self.url(), {"next_action": "x"}, format="json")
        self.assertEqual(resp.status_code, 403)
        own = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.lane, title="Mine",
            created_by=member, position=1,
        )
        resp = self.client.put(self.url(card=own), {"next_action": "x"}, format="json")
        self.assertEqual(resp.status_code, 200)

    def test_non_member_is_denied(self):
        outsider = User.objects.create_user(username="out1922", password="pass")
        self.client.force_authenticate(outsider)
        resp = self.client.put(self.url(), {"next_action": "x"}, format="json")
        self.assertIn(resp.status_code, (403, 404))
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_owner_must_be_an_assignable_member(self):
        outsider = User.objects.create_user(username="out1922b", password="pass")
        viewer = self.member("viewer1922b", BoardMembership.Role.VIEWER)
        for user in (outsider, viewer):
            resp = self.client.put(self.url(), {"owner_id": user.pk}, format="json")
            self.assertEqual(resp.status_code, 400)
            self.assertIn("owner_id", resp.data)

    def test_next_action_length_and_nul(self):
        resp = self.client.put(self.url(), {"next_action": "x" * 201}, format="json")
        self.assertEqual(resp.status_code, 400)
        resp = self.client.put(self.url(), {"next_action": "a\x00b"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_write_serializer_without_board_accepts_no_owner(self):
        """#1075: absent board context denies every owner id."""
        ser = DimensionPlanWriteSerializer(data={"owner_id": self.admin.pk})
        self.assertFalse(ser.is_valid())
        self.assertIn("owner_id", ser.errors)

    def test_board_full_carries_dimension_plans(self):
        CardDimensionPlan.objects.create(card=self.card, field_definition=self.dim, next_action="Ping")
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, 200)
        cards = resp.data["cards"]
        self.assertEqual(cards[0]["dimension_plans"][0]["next_action"], "Ping")

    def test_deleting_the_field_deletes_its_plans(self):
        CardDimensionPlan.objects.create(card=self.card, field_definition=self.dim, next_action="Ping")
        self.dim.delete()
        self.assertFalse(CardDimensionPlan.objects.exists())


class DimensionPinPoolTests(_Base):
    def fields_url(self, field=None):
        base = f"/api/v1/boards/{self.board.pk}/custom-fields/"
        return f"{base}{field.pk}/" if field is not None else base

    def make_dim(self, name, pos):
        return CustomFieldDefinition.objects.create(
            board=self.board, name=name, field_type="dropdown", choices_json=["A"],
            is_dimension=True, position=pos,
        )

    def test_dimensions_pin_from_their_own_pool_of_three(self):
        for i in range(2):
            CustomFieldDefinition.objects.create(
                board=self.board, name=f"G{i}", field_type="text", position=10 + i, show_on_card=True,
            )
        dims = [self.dim, self.make_dim("Budget", 1), self.make_dim("Legal", 2), self.make_dim("Tech", 3)]
        for d in dims[:3]:
            resp = self.client.patch(self.fields_url(d), {"show_on_card": True}, format="json")
            self.assertEqual(resp.status_code, 200, resp.data)
        resp = self.client.patch(self.fields_url(dims[3]), {"show_on_card": True}, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Up to 3 dimensions", str(resp.data["show_on_card"]))

    def test_pinned_dimensions_do_not_take_generic_slots(self):
        for d in (self.dim, self.make_dim("Budget", 1)):
            d.show_on_card = True
            d.save()
        resp = self.client.post(
            self.fields_url(), {"name": "G", "field_type": "text", "show_on_card": True}, format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.data)
        resp = self.client.post(
            self.fields_url(), {"name": "G2", "field_type": "text", "show_on_card": True}, format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.data)
        resp = self.client.post(
            self.fields_url(), {"name": "G3", "field_type": "text", "show_on_card": True}, format="json",
        )
        self.assertEqual(resp.status_code, 400)
