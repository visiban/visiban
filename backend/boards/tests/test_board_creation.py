from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardTemplate, Column, Swimlane


class BoardCreationTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="creator", password="pass")
        self.client.force_authenticate(self.user)

    def _create_board(self, name="My Board", **kwargs):
        payload = {"name": name}
        payload.update(kwargs)
        return self.client.post("/api/boards/", payload)

    def test_creates_five_default_columns_simple_kanban(self):
        """simple_kanban has 5 columns: Backlog / To Do / Doing / Review / Done."""
        resp = self._create_board()
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        self.assertEqual(Column.objects.filter(board_id=board_id).count(), 5)

    def test_default_column_names(self):
        resp = self._create_board()
        board_id = resp.data["id"]
        names = list(
            Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True)
        )
        self.assertEqual(names, ["Backlog", "To Do", "Doing", "Review", "Done"])

    def test_only_first_column_allows_card_creation(self):
        resp = self._create_board()
        board_id = resp.data["id"]
        columns = Column.objects.filter(board_id=board_id).order_by("position")
        self.assertTrue(columns[0].allow_card_creation)
        for col in columns[1:]:
            self.assertFalse(col.allow_card_creation)

    def test_no_swimlane_created_without_swimlane_name(self):
        """When no swimlane_name is provided, no swimlane should be created."""
        resp = self._create_board()
        board_id = resp.data["id"]
        self.assertEqual(Swimlane.objects.filter(board_id=board_id).count(), 0)

    def test_swimlane_created_from_swimlane_name(self):
        """Providing swimlane_name creates exactly one swimlane with that name."""
        resp = self._create_board(swimlane_name="Engineering")
        board_id = resp.data["id"]
        swimlanes = Swimlane.objects.filter(board_id=board_id)
        self.assertEqual(swimlanes.count(), 1)
        self.assertEqual(swimlanes.first().name, "Engineering")

    def test_blank_swimlane_name_creates_no_swimlane(self):
        """Whitespace-only swimlane_name is treated as absent."""
        resp = self._create_board(swimlane_name="   ")
        board_id = resp.data["id"]
        self.assertEqual(Swimlane.objects.filter(board_id=board_id).count(), 0)

    def test_board_listing_excludes_other_users_boards(self):
        other = User.objects.create_user(username="other", password="pass")
        Board.objects.create(name="Other's Board", owner=other)

        resp = self.client.get("/api/boards/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        board_ids = [b["id"] for b in resp.data["results"]]
        other_boards = Board.objects.filter(owner=other).values_list("id", flat=True)
        for board_id in other_boards:
            self.assertNotIn(board_id, board_ids)

    def test_creator_is_board_admin(self):
        from boards.models import BoardMembership
        resp = self._create_board()
        board_id = resp.data["id"]
        membership = BoardMembership.objects.get(board_id=board_id, user=self.user)
        self.assertEqual(membership.role, BoardMembership.Role.ADMIN)

    def test_unauthenticated_cannot_create_board(self):
        anon_client = APIClient()
        resp = anon_client.post("/api/boards/", {"name": "Anon Board"})
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))

    def test_sales_pipeline_columns(self):
        """Sales Pipeline template creates the correct 6 columns."""
        resp = self._create_board(template="sales_pipeline")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        names = list(
            Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True)
        )
        self.assertEqual(names, ["Prospect", "Qualified", "Discovery", "Demo", "Proposal Sent", "Negotiation", "Closed Won", "Closed Lost"])

    def test_customer_support_columns(self):
        """Customer Support template creates the correct 6 columns."""
        resp = self._create_board(template="customer_support")
        board_id = resp.data["id"]
        names = list(
            Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True)
        )
        self.assertEqual(names, ["New", "Triaged", "Investigating", "Awaiting Customer", "Escalated", "Resolved", "Closed"])

    def test_customer_success_columns(self):
        """Customer Success template creates the correct 6 columns."""
        resp = self._create_board(template="customer_success")
        board_id = resp.data["id"]
        names = list(
            Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True)
        )
        self.assertEqual(names, ["Onboarding", "Adoption", "Healthy", "Expansion", "Renewal", "Churned"])

    def test_product_roadmap_columns(self):
        """Product Roadmap template creates the correct 6 columns."""
        resp = self._create_board(template="product_roadmap")
        board_id = resp.data["id"]
        names = list(
            Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True)
        )
        self.assertEqual(names, ["Idea", "Validated", "Scoped", "Prioritized", "In Build", "Beta", "Launched", "Monitoring"])

    def test_project_delivery_columns(self):
        """Project Delivery template creates the correct 7 columns, ending with Done."""
        resp = self._create_board(template="project_delivery")
        board_id = resp.data["id"]
        names = list(
            Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True)
        )
        self.assertEqual(names, ["Planning", "Kickoff", "Execution", "Milestone Review", "Wrap-up", "Retro", "Done"])

    def test_blank_template_creates_no_columns(self):
        """Blank template creates no columns."""
        resp = self._create_board(template="blank")
        board_id = resp.data["id"]
        self.assertEqual(Column.objects.filter(board_id=board_id).count(), 0)

    def test_unknown_template_falls_back_to_simple_kanban(self):
        """An unknown template key falls back to simple_kanban (5 columns)."""
        resp = self._create_board(template="does_not_exist")
        board_id = resp.data["id"]
        self.assertEqual(Column.objects.filter(board_id=board_id).count(), 5)


class BoardTemplateAPITests(TestCase):
    """Tests for GET /api/boards/templates/."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="tpluser", password="pass")
        self.client.force_authenticate(self.user)
        # Ensure the seeded templates exist (data migration may not run in tests)
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

    def test_returns_all_active_templates(self):
        resp = self.client.get("/api/boards/templates/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        slugs = [t["slug"] for t in resp.data]
        self.assertIn("simple_kanban", slugs)
        self.assertIn("sales_pipeline", slugs)
        self.assertIn("blank", slugs)

    def test_returns_eleven_templates(self):
        resp = self.client.get("/api/boards/templates/")
        self.assertEqual(len(resp.data), 11)

    def test_inactive_templates_excluded(self):
        BoardTemplate.objects.filter(slug="blank").update(is_active=False)
        resp = self.client.get("/api/boards/templates/")
        slugs = [t["slug"] for t in resp.data]
        self.assertNotIn("blank", slugs)

    def test_unauthenticated_cannot_fetch_templates(self):
        anon = APIClient()
        resp = anon.get("/api/boards/templates/")
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))

    def test_template_response_fields(self):
        resp = self.client.get("/api/boards/templates/")
        t = next(t for t in resp.data if t["slug"] == "simple_kanban")
        for field in ("id", "name", "slug", "description", "icon", "lane_label", "lane_placeholder", "columns_json", "sort_order"):
            self.assertIn(field, t)


class DefaultBoardTests(TestCase):
    """Tests for default_board_id on the user profile."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="boarduser", password="pass")
        self.client.force_authenticate(self.user)

    def test_default_board_id_null_by_default(self):
        resp = self.client.get("/api/auth/me/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsNone(resp.data["default_board_id"])

    def test_can_set_default_board(self):
        # Create a board for this user
        board_resp = self.client.post("/api/boards/", {"name": "My Board"})
        board_id = board_resp.data["id"]

        resp = self.client.patch("/api/auth/me/", {"default_board_id": board_id})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["default_board_id"], board_id)

    def test_can_clear_default_board(self):
        board_resp = self.client.post("/api/boards/", {"name": "My Board"})
        board_id = board_resp.data["id"]
        self.client.patch("/api/auth/me/", {"default_board_id": board_id})

        # Use format='json' to send null; multipart cannot encode Python None.
        resp = self.client.patch("/api/auth/me/", {"default_board_id": None}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsNone(resp.data["default_board_id"])

    def test_cannot_set_another_users_board_as_default(self):
        """Setting a foreign board PK as default must be rejected at the serializer
        level — the queryset is scoped to boards the requesting user is a member of,
        so a PK belonging to another user's board is not found and DRF returns 400.
        This prevents IDOR enumeration of foreign board IDs via the me/ endpoint.
        """
        other = User.objects.create_user(username="other2", password="pass")
        other_board = Board.objects.create(name="Other Board", owner=other)
        resp = self.client.patch("/api/auth/me/", {"default_board_id": other_board.id})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
