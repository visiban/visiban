"""#1662 — pin the 1.1 -> 1.2 migration graph edges the upgrade path relies on.

accounts 0031 and 0033 depend on django-allauth's
``account.0009_emailaddress_unique_primary_email``. 1.1.0 and 1.2 both pin
django-allauth 65.14.3, which ships that migration. If a future allauth pin
drift removes or renames it, this fails loudly instead of ``migrate`` failing
with NodeNotFoundError on an operator's install.
"""

import pytest
from django.db.migrations.loader import MigrationLoader
from django.test import SimpleTestCase

ALLAUTH_NODE = ("account", "0009_emailaddress_unique_primary_email")


pytestmark = pytest.mark.migrations


class AllauthMigrationDependencyTests(SimpleTestCase):
    def setUp(self):
        self.graph = MigrationLoader(None, ignore_no_migrations=True).graph

    def test_allauth_0009_node_exists(self):
        self.assertIn(ALLAUTH_NODE, self.graph.nodes)

    def test_accounts_migrations_depend_on_it(self):
        for name in (
            "0031_user_pending_email_address",
            "0033_add_user_email_upper_index",
        ):
            parents = self.graph.node_map[("accounts", name)].parents
            self.assertIn(ALLAUTH_NODE, {p.key for p in parents}, name)
