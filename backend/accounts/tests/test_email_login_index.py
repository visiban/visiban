"""Tests for the case-insensitive index on ``users.email`` (#1222).

``accounts.backends.resolve_login_user`` does ``email__iexact=identifier`` on
every anonymous email-login attempt. On PostgreSQL, Django's ``iexact`` lookup
compiles to ``UPPER(email) = UPPER(%s)`` — see
``DatabaseOperations.lookup_cast`` in
``django/db/backends/postgresql/operations.py`` and its use against the LHS in
``django/db/models/lookups.py`` (``BuiltinLookup.as_sql``) — NOT
``LOWER(email) = ...``. A ``Lower(email)`` index would never be selected by
the planner for this query; only an index on the exact same expression,
``Upper(email)``, is eligible.

Two things are under test:

1. The index is declared on the model (``Meta.indexes``), so
   ``makemigrations --check`` stays clean and an accidental removal is caught
   here rather than silently regressing the login path back to a full table
   scan. This runs on any backend.
2. On PostgreSQL specifically, the planner actually chooses that index for
   the exact query ``resolve_login_user`` issues — verified with a real
   ``EXPLAIN``, not assumed from the expression matching syntactically.
"""

import unittest

from django.db import DEFAULT_DB_ALIAS, connections
from django.db.models.functions import Upper
from django.test import TestCase

from accounts.backends import resolve_login_user
from accounts.models import User

POSTGRES_ONLY = unittest.skipUnless(
    connections[DEFAULT_DB_ALIAS].vendor == "postgresql",
    "UPPER(email) is only meaningfully checked against a real PostgreSQL planner; "
    "run against the CI postgres service for this (local dev's seeded backend/.env "
    "uses SQLite)",
)


class EmailUpperIndexPresenceTests(TestCase):
    """The migration-0033 index must stay declared in ``User.Meta.indexes``."""

    def test_index_declared_on_model(self):
        idx = next(
            (i for i in User._meta.indexes if i.name == "user_email_upper_idx"),
            None,
        )
        self.assertIsNotNone(
            idx, "user_email_upper_idx not found in User._meta.indexes"
        )
        # Must be an expression index on Upper("email") — a plain field index,
        # or one on Lower("email"), would not be usable by the iexact query
        # Django actually compiles on PostgreSQL.
        self.assertEqual(len(idx.expressions), 1)
        expr = idx.expressions[0]
        self.assertIsInstance(expr, Upper)
        (source,) = expr.get_source_expressions()
        self.assertEqual(source.name, "email")


class EmailLoginQueryPlanTests(TestCase):
    """PostgreSQL must use the index for the exact resolve_login_user query."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="plan-check-user",
            email="Plan.Check@Example.com",
            password="testpass12345",
            is_active=True,
        )

    @POSTGRES_ONLY
    def test_email_iexact_lookup_uses_upper_index(self):
        """The resolve_login_user email__iexact query must be servable by
        user_email_upper_idx.

        This table has one row in the test fixture, so a cost-based planner
        correctly prefers a sequential scan regardless of which index exists
        — the same reason the MR's manual verification seeded 20k rows for a
        realistic before/after comparison (documented in the MR description).
        Seeding that many rows per test run is not worth the cost here, so
        this instead disables the sequential-scan cost path
        (``enable_seqscan = off``, scoped to this transaction only) and
        confirms the planner falls back to *our* index rather than a full
        scan — proving the index is usable for this exact expression, which
        is the property that regresses silently (e.g. if someone "simplified"
        it back to a ``Lower(email)`` index).
        """
        qs = User._default_manager.filter(
            email__iexact="plan.check@example.com", is_active=True
        ).exclude(email="")
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            cursor.execute("SET LOCAL enable_seqscan = off")
            sql, params = qs.query.sql_with_params()
            cursor.execute(f"EXPLAIN {sql}", params)
            plan = "\n".join(row[0] for row in cursor.fetchall())
        self.assertIn(
            "Index Scan using user_email_upper_idx",
            plan,
            f"expected an index scan on user_email_upper_idx once Seq Scan "
            f"is penalized, got:\n{plan}",
        )

    @POSTGRES_ONLY
    def test_resolve_login_user_still_matches_case_insensitively(self):
        """Guards against a functionally-correct-but-unindexed regression:
        the index must not change which account resolves, only how fast."""
        resolved = resolve_login_user("PLAN.CHECK@EXAMPLE.COM")
        self.assertEqual(resolved, self.user)
