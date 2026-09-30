"""Regression tests for #1165 and #1169.

#1165: malformed ``allowed_priorities`` must 400, never 500.
``backend-schema-fuzz`` sent ``POST /api/v1/groups/`` a body whose
``allowed_priorities`` was not a list of strings; ``validate_allowed_priorities``
iterated it and set-tested each item, which raised ``TypeError`` (not iterable /
unhashable) and surfaced as a 500.

#1169: hardening notes from the post-merge security review of !932. A list
with no length cap and no de-duplication meant an authenticated user could
send (and have stored and broadcast) a list of up to ~1M repeated entries,
and an invalid value was echoed into the 400 body in full.
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

    def test_duplicates_deduplicated_preserving_order(self):
        # Backward compatible: a request with duplicates validated and was
        # stored as-is before #1169 — it must still return 200, but the
        # stored/echoed list is now de-duplicated (first occurrence kept).
        response = self.client.post(
            "/api/v1/groups/",
            {"name": "G", "allowed_priorities": ["low", "urgent", "low", "high", "urgent"]},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.content)
        self.assertEqual(
            response.json()["allowed_priorities"], ["low", "urgent", "high"]
        )
        group = Group.objects.get(name="G")
        self.assertEqual(group.allowed_priorities, ["low", "urgent", "high"])

    def test_oversized_list_rejected_before_iteration(self):
        # A list far longer than any legitimate client would send (#1169 L1)
        # must be rejected cheaply, without depending on any per-item work.
        response = self.client.post(
            "/api/v1/groups/",
            {"name": "G", "allowed_priorities": ["low"] * 1000},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST, response.content)
        self.assertIn("allowed_priorities", response.json())
        self.assertIn("at most", str(response.json()["allowed_priorities"]))

    def test_list_at_cap_still_accepted(self):
        # A list right at the documented cap (all duplicates, so it collapses
        # to a single stored slug) must not be rejected.
        response = self.client.post(
            "/api/v1/groups/",
            {"name": "G", "allowed_priorities": ["low"] * 100},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.content)
        self.assertEqual(response.json()["allowed_priorities"], ["low"])

    def test_length_cap_boundary(self):
        # #1186: the exact off-by-one boundary of the shared cap — a list one
        # entry over the cap must be rejected, and exactly at the cap must be
        # accepted. (test_oversized_list_rejected_before_iteration and
        # test_list_at_cap_still_accepted above cover the same shape with a
        # far-oversized list; this pins the precise boundary the shared
        # ``visiban.utils.MAX_ALLOWED_PRIORITIES_LENGTH`` / boards' identical
        # cap must agree on.)
        from visiban.utils import MAX_ALLOWED_PRIORITIES_LENGTH

        over = self.client.post(
            "/api/v1/groups/",
            {"name": "G-over", "allowed_priorities": ["low"] * (MAX_ALLOWED_PRIORITIES_LENGTH + 1)},
            format="json",
        )
        self.assertEqual(over.status_code, status.HTTP_400_BAD_REQUEST, over.content)
        self.assertIn("at most", str(over.json()["allowed_priorities"]))

        at_cap = self.client.post(
            "/api/v1/groups/",
            {"name": "G-at-cap", "allowed_priorities": ["low"] * MAX_ALLOWED_PRIORITIES_LENGTH},
            format="json",
        )
        self.assertEqual(at_cap.status_code, status.HTTP_201_CREATED, at_cap.content)

    def test_cap_shared_with_board_serializer(self):
        # #1186: GroupSerializer and BoardSerializer independently duplicated
        # this cap after #1169 with nothing keeping the two in sync. Both now
        # source it from visiban.utils.MAX_ALLOWED_PRIORITIES_LENGTH, so this
        # asserts they haven't drifted apart again (e.g. via a local
        # override reintroduced in either app).
        from boards.serializers import _MAX_ALLOWED_PRIORITIES_LENGTH as boards_cap
        from groups.serializers import _MAX_ALLOWED_PRIORITIES_LENGTH as groups_cap
        from visiban.utils import MAX_ALLOWED_PRIORITIES_LENGTH

        self.assertEqual(groups_cap, MAX_ALLOWED_PRIORITIES_LENGTH)
        self.assertEqual(boards_cap, MAX_ALLOWED_PRIORITIES_LENGTH)

    def test_invalid_value_echoed_is_truncated(self):
        # #1169 L2: an invalid string used to be echoed back in full (up to
        # ~20MB) in the 400 body. It must now be truncated.
        huge_bad_value = "x" * 5000
        response = self.client.post(
            "/api/v1/groups/",
            {"name": "G", "allowed_priorities": [huge_bad_value]},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST, response.content)
        body = str(response.json())
        self.assertLess(len(body), 1000)
        self.assertNotIn(huge_bad_value, body)
        self.assertIn("x" * 50, body)
