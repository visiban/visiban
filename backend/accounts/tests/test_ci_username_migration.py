"""Tests for the data migration that resolves case-insensitive username collisions."""

from django.test import TestCase, override_settings

from accounts.models import User


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class DataMigrationLogicTests(TestCase):
    """Test the collision resolution logic directly (the migration has already run)."""

    def test_unique_constraint_prevents_ci_duplicate(self):
        """The functional unique index prevents creating a CI duplicate."""
        User.objects.create_user(
            username="Kelly",
            email="kelly1@example.com",
            password="testpass12345",
        )
        from django.db import IntegrityError
        with self.assertRaises(IntegrityError):
            User.objects.create_user(
                username="kelly",
                email="kelly2@example.com",
                password="testpass12345",
            )

    def test_different_usernames_are_allowed(self):
        User.objects.create_user(
            username="alice",
            email="alice@example.com",
            password="testpass12345",
        )
        User.objects.create_user(
            username="bob",
            email="bob@example.com",
            password="testpass12345",
        )
        self.assertEqual(User.objects.filter(username__in=["alice", "bob"]).count(), 2)

    def test_migration_idempotent_no_collisions(self):
        """Running the migration logic on a DB with no collisions is a no-op."""
        import importlib
        mod = importlib.import_module("accounts.migrations.0020_resolve_ci_username_collisions")
        from django.apps import apps

        User.objects.create_user(username="alpha", email="a@example.com", password="testpass12345")
        User.objects.create_user(username="beta", email="b@example.com", password="testpass12345")

        mod.resolve_collisions(apps, None)

        self.assertEqual(User.objects.filter(must_change_username=True).count(), 0)
