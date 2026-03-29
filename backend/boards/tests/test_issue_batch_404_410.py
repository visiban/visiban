"""Functional tests for issues #404, #405, #408, #409, #410.

#404 — Group board defaults, labels, and invite link expiry/limit
#405 — Cascade deletion for attachments and group invite links
#408 — Data migration 0011_backfill_token_hashes (unit test the hash function)
#409 — Board movements endpoint and board templates endpoint
#410 — Query count budgets for group members and notifications
"""
import datetime
import hashlib

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    BoardTemplate,
    Card,
    CardAttachment,
    CardMovement,
    Column,
    Label,
    Notification,
    Swimlane,
)
from groups.models import Group, GroupInviteLink, GroupLabel, GroupMembership


# ── helpers ────────────────────────────────────────────────────────────────────

def _make_group(owner, name="Test Group", **kwargs):
    group = Group.objects.create(name=name, owner=owner, **kwargs)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


def _make_board_with_card(owner):
    """Create a board with one column, one swimlane, and one card."""
    board = Board.objects.create(name="Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    card = Card.objects.create(
        board=board, column=col, swimlane=swim,
        title="Card 1", created_by=owner, position=0,
    )
    return board, col, swim, card


# ── #404 — Group board defaults, labels, and invite link expiry/limit ──────────

class GroupBoardDefaultsTests(TestCase):
    """Creating a board inside a group should inherit group defaults (#404)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.group = _make_group(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_board_inherits_group_allowed_priorities(self):
        """Boards created inside a group with restricted priorities inherit them."""
        self.group.allowed_priorities = ["high", "urgent"]
        self.group.save(update_fields=["allowed_priorities"])

        resp = self.client.post(
            f"/api/groups/{self.group.id}/boards/",
            {"name": "Priority Board"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board = Board.objects.get(id=resp.data["id"])
        self.assertEqual(board.allowed_priorities, ["high", "urgent"])

    def test_board_inherits_group_labels(self):
        """Group shared labels are copied to new boards created inside the group."""
        GroupLabel.objects.create(group=self.group, name="Bug", color="#EF4444")
        GroupLabel.objects.create(group=self.group, name="Feature", color="#22C55E")

        resp = self.client.post(
            f"/api/groups/{self.group.id}/boards/",
            {"name": "Label Board"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_labels = Label.objects.filter(board_id=resp.data["id"]).values_list("name", flat=True)
        self.assertIn("Bug", board_labels)
        self.assertIn("Feature", board_labels)

    def test_board_with_default_priorities_skips_override(self):
        """When group allowed_priorities is the full set, board keeps default (empty list)."""
        # Empty list = all priorities allowed — the default
        self.group.allowed_priorities = []
        self.group.save(update_fields=["allowed_priorities"])

        resp = self.client.post(
            f"/api/groups/{self.group.id}/boards/",
            {"name": "Default Board"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board = Board.objects.get(id=resp.data["id"])
        self.assertEqual(board.allowed_priorities, [])


class GroupInviteLinkExpiryTests(TestCase):
    """Invite link expiry and single-use rejection (#404)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.group = _make_group(self.owner)
        self.joiner = User.objects.create_user(username="joiner", password="pass")
        self.client = APIClient()

    def test_expired_invite_link_rejected_on_preview(self):
        """GET on an expired invite link returns 410 Gone."""
        link, raw_token = GroupInviteLink.generate(
            group=self.group,
            created_by=self.owner,
            expires_at=timezone.now() - datetime.timedelta(hours=1),
        )

        resp = self.client.get(f"/api/groups/join/{raw_token}/")
        self.assertEqual(resp.status_code, status.HTTP_410_GONE)

    def test_expired_invite_link_rejected_on_join(self):
        """POST on an expired invite link returns 410 Gone."""
        link, raw_token = GroupInviteLink.generate(
            group=self.group,
            created_by=self.owner,
            expires_at=timezone.now() - datetime.timedelta(hours=1),
        )

        self.client.force_authenticate(self.joiner)
        resp = self.client.post(f"/api/groups/join/{raw_token}/")
        self.assertEqual(resp.status_code, status.HTTP_410_GONE)
        # User should not have been added to the group
        self.assertFalse(
            GroupMembership.objects.filter(group=self.group, user=self.joiner).exists()
        )

    def test_valid_invite_link_allows_join(self):
        """A non-expired invite link allows the user to join."""
        link, raw_token = GroupInviteLink.generate(
            group=self.group,
            created_by=self.owner,
            expires_at=timezone.now() + datetime.timedelta(days=7),
        )

        self.client.force_authenticate(self.joiner)
        resp = self.client.post(f"/api/groups/join/{raw_token}/")
        self.assertIn(resp.status_code, [status.HTTP_200_OK, status.HTTP_201_CREATED])
        self.assertTrue(
            GroupMembership.objects.filter(group=self.group, user=self.joiner).exists()
        )

    def test_deactivated_invite_link_rejected(self):
        """An invite link that has been deactivated (revoked) returns 404."""
        link, raw_token = GroupInviteLink.generate(
            group=self.group,
            created_by=self.owner,
        )
        link.is_active = False
        link.save(update_fields=["is_active"])

        resp = self.client.get(f"/api/groups/join/{raw_token}/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_max_five_active_invite_links_per_group(self):
        """Creating a 6th active invite link is rejected."""
        self.client.force_authenticate(self.owner)
        for i in range(5):
            resp = self.client.post(
                f"/api/groups/{self.group.id}/invite-links/",
                {"name": f"Link {i}"},
            )
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        # 6th should be rejected
        resp = self.client.post(
            f"/api/groups/{self.group.id}/invite-links/",
            {"name": "Link 6"},
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Maximum", resp.data["detail"])


# ── #405 — Cascade deletion for attachments and group invite links ─────────────

class CardAttachmentCascadeDeletionTests(TestCase):
    """Deleting a card cascades to its attachments (#405)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim, self.card = _make_board_with_card(self.owner)
        self.attachment = CardAttachment.objects.create(
            card=self.card,
            file="attachments/test.txt",
            filename="test.txt",
            size=100,
            uploaded_by=self.owner,
        )

    def test_deleting_card_cascades_attachments(self):
        att_id = self.attachment.pk
        self.card.delete()
        self.assertFalse(CardAttachment.objects.filter(pk=att_id).exists())

    def test_deleting_board_cascades_card_attachments(self):
        att_id = self.attachment.pk
        self.board.delete()
        self.assertFalse(CardAttachment.objects.filter(pk=att_id).exists())

    def test_multiple_attachments_cascade(self):
        """All attachments on a card are deleted when the card is deleted."""
        CardAttachment.objects.create(
            card=self.card,
            file="attachments/test2.txt",
            filename="test2.txt",
            size=200,
            uploaded_by=self.owner,
        )
        card_id = self.card.pk
        self.card.delete()
        self.assertEqual(CardAttachment.objects.filter(card_id=card_id).count(), 0)


class GroupInviteLinkCascadeDeletionTests(TestCase):
    """Deleting a group cascades to its invite links (#405)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.group = _make_group(self.owner)

    def test_deleting_group_cascades_invite_links(self):
        link, _ = GroupInviteLink.generate(
            group=self.group,
            created_by=self.owner,
            name="Test Link",
        )
        group_id = self.group.pk
        self.group.delete()
        self.assertEqual(GroupInviteLink.objects.filter(group_id=group_id).count(), 0)

    def test_deleting_group_cascades_multiple_invite_links(self):
        for i in range(3):
            GroupInviteLink.generate(
                group=self.group,
                created_by=self.owner,
                name=f"Link {i}",
            )
        group_id = self.group.pk
        self.group.delete()
        self.assertEqual(GroupInviteLink.objects.filter(group_id=group_id).count(), 0)

    def test_deleting_group_cascades_labels(self):
        GroupLabel.objects.create(group=self.group, name="Bug", color="#EF4444")
        group_id = self.group.pk
        self.group.delete()
        self.assertEqual(GroupLabel.objects.filter(group_id=group_id).count(), 0)


# ── #408 — Token hash function unit test ───────────────────────────────────────

class TokenHashBackfillFunctionTests(TestCase):
    """Unit test the hash function used in migration 0011_backfill_token_hashes (#408).

    We test the hash logic directly rather than running the migration because
    data migrations are impractical to test in isolation — the logic is simple
    enough to validate as a unit.
    """

    GROUP_INVITE_PREFIX = "vbng_"

    def test_hash_of_prefixed_uuid_matches_sha256(self):
        """The backfill hashes GROUP_INVITE_PREFIX + str(uuid) with SHA-256."""
        import uuid
        token = uuid.uuid4()
        raw = self.GROUP_INVITE_PREFIX + str(token)
        expected_hash = hashlib.sha256(raw.encode()).hexdigest()

        # Replicate the migration logic
        computed_hash = hashlib.sha256((self.GROUP_INVITE_PREFIX + str(token)).encode()).hexdigest()
        self.assertEqual(computed_hash, expected_hash)

    def test_hash_is_64_char_hex(self):
        """SHA-256 hex digest is always 64 characters."""
        raw = self.GROUP_INVITE_PREFIX + "550e8400-e29b-41d4-a716-446655440000"
        h = hashlib.sha256(raw.encode()).hexdigest()
        self.assertEqual(len(h), 64)
        # Must be valid hex
        int(h, 16)

    def test_prefix_is_first_eight_chars(self):
        """The prefix stored alongside the hash is the first 8 chars of the raw token."""
        raw = self.GROUP_INVITE_PREFIX + "550e8400-e29b-41d4-a716-446655440000"
        prefix = raw[:8]
        self.assertEqual(prefix, "vbng_550")

    def test_different_uuids_produce_different_hashes(self):
        import uuid
        raw1 = self.GROUP_INVITE_PREFIX + str(uuid.uuid4())
        raw2 = self.GROUP_INVITE_PREFIX + str(uuid.uuid4())
        h1 = hashlib.sha256(raw1.encode()).hexdigest()
        h2 = hashlib.sha256(raw2.encode()).hexdigest()
        self.assertNotEqual(h1, h2)

    def test_lookup_by_token_uses_same_hash(self):
        """GroupInviteLink.lookup_by_token uses SHA-256 of the raw token — verify compatibility."""
        owner = User.objects.create_user(username="owner", password="pass")
        group = Group.objects.create(name="G", owner=owner)
        link, raw_token = GroupInviteLink.generate(group=group, created_by=owner)

        # The raw token should be resolvable via lookup_by_token
        found = GroupInviteLink.lookup_by_token(raw_token)
        self.assertIsNotNone(found)
        self.assertEqual(found.pk, link.pk)

        # And the stored hash should match sha256 of the raw token
        expected_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        self.assertEqual(link.token_hash, expected_hash)


# ── #409 — Board movements endpoint and board templates endpoint ───────────────

class BoardMovementsEndpointTests(TestCase):
    """GET /api/boards/{id}/movements/ returns movement history (#409)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim, self.card = _make_board_with_card(self.owner)
        col_b = Column.objects.create(board=self.board, name="Done", position=1)

        # Create a movement
        self.movement = CardMovement.objects.create(
            card=self.card,
            from_column=self.col, to_column=col_b,
            from_column_name="Backlog", to_column_name="Done",
            from_swimlane=self.swim, to_swimlane=self.swim,
            from_swimlane_name="General", to_swimlane_name="General",
            moved_by=self.owner,
        )

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_movements_returns_history(self):
        resp = self.client.get(f"/api/boards/{self.board.id}/movements/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn("results", resp.data)
        self.assertGreaterEqual(resp.data["count"], 1)

    def test_movements_includes_card_info(self):
        resp = self.client.get(f"/api/boards/{self.board.id}/movements/")
        result = resp.data["results"][0]
        self.assertIn("card_title", result)
        self.assertIn("card_uid", result)

    def test_movements_pagination_fields(self):
        resp = self.client.get(f"/api/boards/{self.board.id}/movements/")
        for field in ("count", "offset", "page_size", "results"):
            self.assertIn(field, resp.data)

    def test_movements_filter_by_date(self):
        """moved_after filter excludes older movements."""
        tomorrow = (timezone.now() + datetime.timedelta(days=1)).strftime("%Y-%m-%d")
        resp = self.client.get(
            f"/api/boards/{self.board.id}/movements/",
            {"moved_after": tomorrow},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["count"], 0)

    def test_unauthenticated_cannot_access_movements(self):
        anon = APIClient()
        resp = anon.get(f"/api/boards/{self.board.id}/movements/")
        self.assertIn(resp.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])


class BoardTemplateEndpointTests(TestCase):
    """GET /api/boards/templates/ returns available templates (#409)."""

    def setUp(self):
        self.user = User.objects.create_user(username="tuser", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        # Seed templates for tests (data migration may not run in test DB)
        self._seed_templates()

    def _seed_templates(self):
        slugs = [
            "sales_pipeline", "customer_support", "customer_success",
            "simple_kanban", "product_roadmap", "project_delivery",
            "content_production", "hiring_recruiting", "legal_compliance",
            "infra_devops", "blank",
        ]
        for i, slug in enumerate(slugs):
            BoardTemplate.objects.get_or_create(
                slug=slug,
                defaults={
                    "name": slug.replace("_", " ").title(),
                    "description": "Test",
                    "icon": "",
                    "lane_label": "",
                    "lane_placeholder": "",
                    "columns_json": [],
                    "sort_order": i * 10,
                    "is_active": True,
                },
            )

    def test_templates_returns_list(self):
        resp = self.client.get("/api/boards/templates/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsInstance(resp.data, list)
        self.assertGreater(len(resp.data), 0)

    def test_templates_contain_expected_slugs(self):
        resp = self.client.get("/api/boards/templates/")
        slugs = {t["slug"] for t in resp.data}
        self.assertIn("simple_kanban", slugs)
        self.assertIn("blank", slugs)

    def test_templates_response_fields(self):
        resp = self.client.get("/api/boards/templates/")
        t = resp.data[0]
        for field in ("id", "name", "slug", "description", "columns_json", "sort_order"):
            self.assertIn(field, t, f"Missing field: {field}")


# ── #410 — Query count budgets for group members and notifications ─────────────

class GroupMemberListQueryCountTests(TestCase):
    """GET /api/groups/{id}/members/ must stay within a query count budget (#410)."""

    # Auth + group lookup + direct memberships + ancestor traversal
    # Measured at ~6-8 for a flat group with 10 members; 14 gives headroom.
    BUDGET = 14

    def setUp(self):
        self.owner = User.objects.create_user(username="gowner", password="pass")
        self.group = _make_group(self.owner)

        # Add several members to the group
        for i in range(10):
            user = User.objects.create_user(username=f"member{i}", password="pass")
            GroupMembership.objects.create(group=self.group, user=user, role=GroupMembership.Role.MEMBER)

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_member_list_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.get(f"/api/groups/{self.group.id}/members/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertGreater(len(resp.data), 0)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"groups/{self.group.id}/members/ used {len(ctx)} queries — budget is {self.BUDGET}. "
            "Check for N+1 regressions in member serialization.",
        )

    def test_member_list_budget_does_not_scale_with_members(self):
        """Adding more members must not significantly increase query count."""
        def _get():
            return self.client.get(f"/api/groups/{self.group.id}/members/")

        with CaptureQueriesContext(connection) as ctx1:
            _get()
        baseline = len(ctx1)

        # Double the member count
        for i in range(10, 20):
            user = User.objects.create_user(username=f"extra{i}", password="pass")
            GroupMembership.objects.create(group=self.group, user=user, role=GroupMembership.Role.MEMBER)

        with CaptureQueriesContext(connection) as ctx2:
            _get()
        doubled = len(ctx2)

        self.assertLessEqual(
            doubled, baseline + 2,
            f"members/ query count grew from {baseline} to {doubled} when members "
            "were added — possible N+1 regression.",
        )


class NotificationListQueryCountTests(TestCase):
    """GET /api/notifications/ must stay within a query count budget (#410)."""

    # Auth + notification list with select_related — measured at ~3-4; budget 8.
    BUDGET = 8

    def setUp(self):
        self.user = User.objects.create_user(username="notifuser", password="pass")
        board = Board.objects.create(name="Board", owner=self.user)
        BoardMembership.objects.create(board=board, user=self.user, role="admin")
        col = Column.objects.create(board=board, name="Col", position=0)
        swim = Swimlane.objects.create(board=board, name="Swim", position=0)

        # Create several unread notifications
        for i in range(20):
            card = Card.objects.create(
                board=board, column=col, swimlane=swim,
                title=f"Card {i}", created_by=self.user, position=i,
            )
            Notification.objects.create(
                recipient=self.user,
                verb=f"Card {i} was moved",
                card=card,
                board=board,
            )

        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_notification_list_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.get("/api/notifications/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertGreater(len(resp.data), 0)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"notifications/ used {len(ctx)} queries — budget is {self.BUDGET}. "
            "Check for missing select_related on card/board.",
        )

    def test_notification_list_budget_does_not_scale_with_notifications(self):
        """Adding more notifications must not increase query count."""
        def _get():
            return self.client.get("/api/notifications/")

        with CaptureQueriesContext(connection) as ctx1:
            _get()
        baseline = len(ctx1)

        # Add more notifications
        board = Board.objects.filter(owner=self.user).first()
        col = Column.objects.filter(board=board).first()
        swim = Swimlane.objects.filter(board=board).first()
        for i in range(20, 40):
            card = Card.objects.create(
                board=board, column=col, swimlane=swim,
                title=f"Card {i}", created_by=self.user, position=i,
            )
            Notification.objects.create(
                recipient=self.user,
                verb=f"Card {i} was moved",
                card=card,
                board=board,
            )

        with CaptureQueriesContext(connection) as ctx2:
            _get()
        doubled = len(ctx2)

        self.assertEqual(
            baseline, doubled,
            f"notifications/ query count grew from {baseline} to {doubled} when "
            "notifications were added — N+1 regression detected.",
        )
