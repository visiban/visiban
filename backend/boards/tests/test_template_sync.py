"""Tests for boards.template_sync — the idempotent BoardTemplate sync used by
BoardsConfig.ready() (post_migrate) and covering the boards.hooks.TEMPLATE_PROVIDERS
extension point (#1115).
"""

from django.test import TestCase

from boards import hooks
from boards.models import BoardTemplate
from boards.template_sync import sync_board_templates


def _fake_provider():
    return [{
        "slug": "test_provider_template",
        "name": "Test Provider Template",
        "description": "Registered by a test provider",
        "icon": "flag",
        "sort_order": 999,
        "is_active": True,
        "lane_label": "Widget",
        "lane_placeholder": "e.g. Widget A",
        "columns": [
            {"name": "Todo", "color": "#6B7280", "position": 0},
            {"name": "Done", "color": "#10B981", "position": 1, "is_done": True},
        ],
    }]


def _raising_provider():
    raise RuntimeError("boom")


def _malformed_provider():
    # Missing the required "slug" key.
    return [{"name": "No Slug Here", "columns": []}]


def _missing_name_provider():
    # Has a slug, but is missing the required "name" key — must be skipped
    # per-entry, not abort the whole sync pass.
    return [{"slug": "missing_name_template", "columns": []}]


class TemplateProviderRegistrationTests(TestCase):
    """A provider registered in boards.hooks.TEMPLATE_PROVIDERS must be picked
    up by sync_board_templates() the same way the built-in templates are."""

    def tearDown(self):
        hooks.TEMPLATE_PROVIDERS.clear()

    def test_provider_template_is_inserted(self):
        hooks.TEMPLATE_PROVIDERS.append(_fake_provider)
        sync_board_templates()

        tpl = BoardTemplate.objects.get(slug="test_provider_template")
        self.assertEqual(tpl.name, "Test Provider Template")
        self.assertEqual(tpl.lane_label, "Widget")
        self.assertEqual(
            [c["name"] for c in tpl.columns_json], ["Todo", "Done"],
        )
        self.assertTrue(tpl.columns_json[1]["is_done"])

    def test_provider_template_appears_in_list_endpoint(self):
        from django.test import Client
        from accounts.models import User

        hooks.TEMPLATE_PROVIDERS.append(_fake_provider)
        sync_board_templates()

        user = User.objects.create_user(username="provideruser", password="pass")
        client = Client()
        client.force_login(user)
        resp = client.get("/api/v1/boards/templates/")
        self.assertEqual(resp.status_code, 200)
        slugs = [t["slug"] for t in resp.json()]
        self.assertIn("test_provider_template", slugs)

    def test_running_sync_twice_does_not_duplicate(self):
        hooks.TEMPLATE_PROVIDERS.append(_fake_provider)
        sync_board_templates()
        sync_board_templates()
        self.assertEqual(
            BoardTemplate.objects.filter(slug="test_provider_template").count(), 1,
        )

    def test_raising_provider_is_skipped_without_breaking_sync(self):
        """A misbehaving provider must not stop built-ins (or other
        providers) from being synced — same defensive pattern as
        ANALYTICS_EXTENSIONS."""
        hooks.TEMPLATE_PROVIDERS.append(_raising_provider)
        hooks.TEMPLATE_PROVIDERS.append(_fake_provider)

        sync_board_templates()  # must not raise

        self.assertTrue(BoardTemplate.objects.filter(slug="simple_kanban").exists())
        self.assertTrue(BoardTemplate.objects.filter(slug="test_provider_template").exists())

    def test_malformed_provider_entry_is_skipped(self):
        hooks.TEMPLATE_PROVIDERS.append(_malformed_provider)
        sync_board_templates()  # must not raise
        self.assertTrue(BoardTemplate.objects.filter(slug="simple_kanban").exists())

    def test_provider_entry_missing_a_required_key_is_skipped_without_aborting_sync(self):
        """A malformed entry missing "name" (or any key beyond "slug") must
        be skipped per-entry — it must not stop the built-ins, or a
        well-formed provider registered after it, from being synced."""
        hooks.TEMPLATE_PROVIDERS.append(_missing_name_provider)
        hooks.TEMPLATE_PROVIDERS.append(_fake_provider)

        sync_board_templates()  # must not raise

        self.assertFalse(BoardTemplate.objects.filter(slug="missing_name_template").exists())
        self.assertTrue(BoardTemplate.objects.filter(slug="simple_kanban").exists())
        self.assertTrue(BoardTemplate.objects.filter(slug="test_provider_template").exists())

    def test_sync_never_overwrites_an_existing_row(self):
        """Insert-only conflict policy: once a slug's row exists, sync must
        never touch it again, whether it came from a migration or a prior
        sync run — see boards/template_sync.py's module docstring."""
        BoardTemplate.objects.filter(slug="simple_kanban").update(
            name="Renamed By Someone", columns_json=[{"name": "Custom", "color": "#000000", "position": 0}],
        )
        sync_board_templates()
        tpl = BoardTemplate.objects.get(slug="simple_kanban")
        self.assertEqual(tpl.name, "Renamed By Someone")
        self.assertEqual(tpl.columns_json, [{"name": "Custom", "color": "#000000", "position": 0}])


class SyncBoardTemplatesBuiltinTests(TestCase):
    """sync_board_templates() with no providers registered must be a no-op
    once the built-in migrations have already run (the normal case for this
    test DB) — OSS behavior is unchanged with an empty TEMPLATE_PROVIDERS."""

    def test_all_eleven_builtins_present_and_stable(self):
        before = {t.slug: t.columns_json for t in BoardTemplate.objects.all()}
        sync_board_templates()
        after = {t.slug: t.columns_json for t in BoardTemplate.objects.all()}
        self.assertEqual(before, after)
        self.assertEqual(len(after), 11)
