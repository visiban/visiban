"""Regression tests for #1165: malformed ``allowed_priorities`` must 400, never 500.

``backend-schema-fuzz`` sent ``POST /api/v1/groups/`` a body whose
``allowed_priorities`` was not a list of strings; ``validate_allowed_priorities``
iterated it and set-tested each item, which raised ``TypeError`` (not iterable /
unhashable) and surfaced as a 500.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupMembership


class AllowedPrioritiesValidationTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _assert_rejected(self, response):
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST, response.content)
        self.assertIn("allowed_priorities", response.json())

    def test_create_rejects_non_list_values(self):
        for bad in (5, "high", {"a": 1}, True):
            with self.subTest(value=bad):
                self._assert_rejected(
                    self.client.post(
                        "/api/v1/groups/",
                        {"name": "G", "allowed_priorities": bad},
                        format="json",
                    )
                )

    def test_create_rejects_unhashable_and_non_string_items(self):
        for bad in ([["low"]], [{"a": 1}], [1], [None], [["a"], "low"]):
            with self.subTest(value=bad):
                self._assert_rejected(
                    self.client.post(
                        "/api/v1/groups/",
                        {"name": "G", "allowed_priorities": bad},
                        format="json",
                    )
                )

    def test_update_rejects_malformed_value(self):
        group = Group.objects.create(name="G", owner=self.owner)
        GroupMembership.objects.create(
            group=group, user=self.owner, role=GroupMembership.Role.ADMIN
        )
        for bad in ([["low"]], 5, {"a": 1}):
            with self.subTest(value=bad):
                self._assert_rejected(
                    self.client.patch(
                        f"/api/v1/groups/{group.pk}/",
                        {"allowed_priorities": bad},
                        format="json",
                    )
                )

    def test_valid_priorities_still_accepted(self):
        response = self.client.post(
            "/api/v1/groups/",
            {"name": "G", "allowed_priorities": ["low", "urgent"]},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.content)
        self.assertEqual(response.json()["allowed_priorities"], ["low", "urgent"])
