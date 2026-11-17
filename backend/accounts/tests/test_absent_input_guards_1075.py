"""Absent-input tests for the accounts guards the #1075 sweep changed.

See ``boards/tests/test_absent_input_guards_1075.py`` for the rule.
"""
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.test import TestCase

from accounts.admin_views import AdminPatchUserSerializer

User = get_user_model()


class AdminPatchUserSerializerAbsentTargetTests(TestCase):
    """The superuser guards raise when the target is missing, never skip."""

    def setUp(self):
        self.superuser = User.objects.create_superuser(
            username="su_1075", email="su1075@example.com", password=None,
        )

    def test_missing_target_raises_instead_of_skipping_the_guard(self):
        for field in ("is_site_admin", "can_access_all_content"):
            serializer = AdminPatchUserSerializer(data={field: False}, partial=True)
            with self.assertRaises(ImproperlyConfigured):
                serializer.is_valid()

    def test_target_present_still_refuses_clearing_a_superusers_flags(self):
        for field in ("is_site_admin", "can_access_all_content"):
            serializer = AdminPatchUserSerializer(
                data={field: False}, partial=True, context={"target": self.superuser},
            )
            self.assertFalse(serializer.is_valid())
            self.assertIn(field, serializer.errors)
