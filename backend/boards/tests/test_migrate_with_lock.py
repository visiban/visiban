"""Tests for the `migrate_with_lock` management command (#1117).

The command is the piece that makes it safe for migrations to run in the backend
pod instead of a Helm pre-install hook Job, so the thing worth testing is the
LOCK, not that `migrate` can be called. Four properties have to hold or the Helm
chart's migrate init container is unsafe with backendReplicaCount > 1:

1. a second invocation WAITS instead of migrating alongside the first;
2. it fails loudly rather than starting the app when the wait is exhausted;
3. a holder that dies without unlocking does not wedge every later deploy;
4. the lock is released when the migration itself raises.

Properties 1, 3 and 4 need real advisory locks, so those tests skip on SQLite —
which is what local development and this worktree's seeded backend/.env use. CI's
backend-test jobs run against postgres:17-alpine, where they do run. The skip is
explicit and named so a green local run is never mistaken for coverage.

No threads here on purpose: everything is exercised with a second explicit
database connection in the same thread, which sidesteps the thread-local
connection-leak trap in CLAUDE.md entirely.
"""

from __future__ import annotations

import logging
import os
import unittest
import warnings
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, OperationalError, connections
from django.test import SimpleTestCase, TransactionTestCase

from boards.management.commands.migrate_with_lock import (
    DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_LOCK_TIMEOUT,
    MIGRATION_LOCK_KEY,
    _connect_timeout_from_env,
    _lock_timeout_from_env,
    _positive_int,
    _unpooled_settings,
)

POSTGRES_ONLY = unittest.skipUnless(
    connections[DEFAULT_DB_ALIAS].vendor == "postgresql",
    "advisory locks are PostgreSQL-only; run against the CI postgres service for this",
)


def _lock_is_free() -> bool:
    """True when no other session holds the migration advisory lock.

    Probed by taking the lock and immediately giving it back, rather than by
    decoding pg_locks: a bigint advisory key is split across classid/objid there,
    and a check that gets the split wrong reports "free" forever — a green test
    that asserts nothing. The test connection never holds this lock itself, so
    advisory locks' same-session re-entrancy cannot make this lie.
    """
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", [MIGRATION_LOCK_KEY])
        acquired = cursor.fetchone()[0]
        if acquired:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [MIGRATION_LOCK_KEY])
        return acquired


class UnpooledLockConnectionTests(SimpleTestCase):
    """The lock session must never come from the psycopg pool (#1958)."""

    def test_pool_option_is_removed_and_other_options_kept(self):
        original = {"ENGINE": "django.db.backends.postgresql", "OPTIONS": {"sslmode": "require", "pool": {"min_size": 2}}}
        cleaned = _unpooled_settings(original)
        self.assertEqual(cleaned["OPTIONS"], {"sslmode": "require"})
        self.assertIn("pool", original["OPTIONS"])  # the registered connection is untouched

    def test_missing_options_is_tolerated(self):
        self.assertEqual(_unpooled_settings({"ENGINE": "x"})["OPTIONS"], {})


class PositiveIntTests(TransactionTestCase):
    """The tuning knobs fall back rather than crash the whole Deployment."""

    def test_blank_and_malformed_values_fall_back(self):
        self.assertEqual(_positive_int("", 300), 300)
        self.assertEqual(_positive_int("not-a-number", 300), 300)
        self.assertEqual(_positive_int("0", 300), 300)
        self.assertEqual(_positive_int("-5", 300), 300)

    def test_a_valid_value_is_used(self):
        self.assertEqual(_positive_int("42", 300), 42)


class TimeoutEnvAliasTests(SimpleTestCase):
    """MIGRATE_*_TIMEOUT_SECONDS with the 1.2 pre-release VISIBAN_ names as working aliases (#1873)."""

    CASES = [
        # (resolver, canonical, legacy, default)
        (_connect_timeout_from_env, "MIGRATE_CONNECT_TIMEOUT_SECONDS", "VISIBAN_MIGRATE_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT),
        (_lock_timeout_from_env, "MIGRATE_LOCK_TIMEOUT_SECONDS", "VISIBAN_MIGRATE_LOCK_TIMEOUT", DEFAULT_LOCK_TIMEOUT),
    ]

    def _resolve(self, resolver, new, old, values):
        """Run `resolver` with exactly `values` set for the two names; return (result, log lines)."""
        with patch.dict(os.environ, values, clear=False):
            for name in (new, old):
                if name not in values:
                    os.environ.pop(name, None)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                with self.assertLogs("visiban.env_aliases", level="WARNING") as logs:
                    # assertLogs fails on silence; one sentinel line keeps the
                    # "no warning" cases checkable as len(output) == 1.
                    logging.getLogger("visiban.env_aliases").warning("sentinel-1873")
                    result = resolver()
        return result, logs.output[1:]

    def test_neither_set_uses_the_default(self):
        for resolver, new, old, default in self.CASES:
            with self.subTest(new=new):
                result, logged = self._resolve(resolver, new, old, {})
                self.assertEqual(result, default)
                self.assertEqual(logged, [])

    def test_old_name_only_still_works_and_warns(self):
        for resolver, new, old, _default in self.CASES:
            with self.subTest(new=new):
                result, logged = self._resolve(resolver, new, old, {old: "42"})
                self.assertEqual(result, 42)
                self.assertEqual(len(logged), 1)
                self.assertIn(f"{old} is deprecated; rename it to {new}", logged[0])

    def test_new_name_only_works_without_warning(self):
        for resolver, new, old, _default in self.CASES:
            with self.subTest(new=new):
                result, logged = self._resolve(resolver, new, old, {new: "43"})
                self.assertEqual(result, 43)
                self.assertEqual(logged, [])

    def test_both_set_new_wins(self):
        for resolver, new, old, _default in self.CASES:
            with self.subTest(new=new):
                result, _logged = self._resolve(resolver, new, old, {new: "43", old: "42"})
                self.assertEqual(result, 43)

    def test_empty_new_does_not_shadow_the_old_value(self):
        for resolver, new, old, _default in self.CASES:
            with self.subTest(new=new):
                result, _logged = self._resolve(resolver, new, old, {new: "", old: "42"})
                self.assertEqual(result, 42)

    def test_empty_old_alone_falls_back_to_the_default_as_before(self):
        for resolver, new, old, default in self.CASES:
            with self.subTest(new=new):
                result, logged = self._resolve(resolver, new, old, {old: ""})
                self.assertEqual(result, default)
                self.assertEqual(logged, [])


class DatabaseWaitTests(TransactionTestCase):
    """The command retries a database that is not up yet, then gives up loudly."""

    def test_gives_up_with_a_message_naming_the_timeout(self):
        """A database that never answers fails the init container, it does not hang."""
        with patch.object(
            connections[DEFAULT_DB_ALIAS],
            "ensure_connection",
            side_effect=OperationalError('could not translate host name "db" to address'),
        ):
            with self.assertRaises(CommandError) as ctx:
                call_command("migrate_with_lock", connect_timeout=1, stdout=StringIO())

        message = str(ctx.exception)
        self.assertIn("did not accept a connection within 1s", message)
        # The underlying driver error is worth surfacing; the credentials behind
        # it are not. Nothing in the command renders DATABASE_URL itself.
        self.assertNotIn("password", message.lower())

    def test_migrate_is_not_attempted_when_the_database_never_answers(self):
        with patch.object(
            connections[DEFAULT_DB_ALIAS],
            "ensure_connection",
            side_effect=OperationalError("nope"),
        ):
            with patch(
                "boards.management.commands.migrate_with_lock.call_command"
            ) as migrate:
                with self.assertRaises(CommandError):
                    call_command("migrate_with_lock", connect_timeout=1, stdout=StringIO())
        migrate.assert_not_called()


class NonPostgresTests(TransactionTestCase):
    """SQLite has no advisory locks, so the command must degrade, not fail."""

    def test_runs_migrate_without_a_lock_and_says_so(self):
        out = StringIO()
        with patch.object(type(connections[DEFAULT_DB_ALIAS]), "vendor", "sqlite"):
            with patch(
                "boards.management.commands.migrate_with_lock.call_command"
            ) as migrate:
                call_command("migrate_with_lock", stdout=out)

        migrate.assert_called_once()
        self.assertEqual(migrate.call_args.args[0], "migrate")
        self.assertIs(migrate.call_args.kwargs["interactive"], False)
        self.assertIn("no advisory locks", out.getvalue())


@POSTGRES_ONLY
class AdvisoryLockTests(TransactionTestCase):
    """The lock behaves the way concurrent backend replicas need it to."""

    def setUp(self):
        self.other = connections.create_connection(DEFAULT_DB_ALIAS)
        self.addCleanup(self.other.close)

    def _take_lock_elsewhere(self):
        with self.other.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s)", [MIGRATION_LOCK_KEY])
            self.assertTrue(cursor.fetchone()[0], "could not take the lock for the test")

    def test_a_second_invocation_refuses_rather_than_migrating_alongside(self):
        """The replica that loses the race must not start against a half-migrated schema."""
        self._take_lock_elsewhere()

        with patch(
            "boards.management.commands.migrate_with_lock.call_command"
        ) as migrate:
            with self.assertRaises(CommandError) as ctx:
                call_command("migrate_with_lock", lock_timeout=1, stdout=StringIO())

        migrate.assert_not_called()
        self.assertIn("held the migration lock", str(ctx.exception))

    def test_it_proceeds_once_the_other_holder_releases(self):
        """A waiting replica migrates after the winner finishes — it does not skip."""
        self._take_lock_elsewhere()
        with self.other.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [MIGRATION_LOCK_KEY])

        with patch(
            "boards.management.commands.migrate_with_lock.call_command"
        ) as migrate:
            call_command("migrate_with_lock", lock_timeout=5, stdout=StringIO())

        migrate.assert_called_once()
        self.assertEqual(migrate.call_args.args[0], "migrate")

    def test_the_lock_dies_with_its_session(self):
        """A pod OOM-killed mid-migration must not wedge every later deploy.

        This is the property that rules out a lock table or a lock ROW: those
        survive the holder, and the next deploy would need manual cleanup.
        """
        self._take_lock_elsewhere()
        self.assertFalse(_lock_is_free())

        # No unlock — just drop the session, the way a killed pod does.
        self.other.close()

        with patch("boards.management.commands.migrate_with_lock.call_command"):
            call_command("migrate_with_lock", lock_timeout=5, stdout=StringIO())
        self.assertTrue(_lock_is_free(), "the lock outlived its session")

    def test_the_lock_is_released_when_the_migration_fails(self):
        """A failed migration must leave the lock free for the retry."""
        with patch(
            "boards.management.commands.migrate_with_lock.call_command",
            side_effect=RuntimeError("migration blew up"),
        ):
            with self.assertRaises(RuntimeError):
                call_command("migrate_with_lock", lock_timeout=5, stdout=StringIO())

        self.assertTrue(_lock_is_free())

    def test_the_lock_is_released_on_success(self):
        with patch("boards.management.commands.migrate_with_lock.call_command"):
            call_command("migrate_with_lock", lock_timeout=5, stdout=StringIO())

        self.assertTrue(_lock_is_free())

    def test_migrate_does_not_run_on_the_connection_holding_the_lock(self):
        """The lock must survive anything `migrate` does to its own connection.

        A non-atomic migration that closes and reopens the default connection
        would silently drop a lock held there, and nothing would report it — the
        migration would simply continue with no mutual exclusion at all.
        """
        observed = {}

        def _fake_migrate(*args, **kwargs):
            # Slam the default connection shut, exactly as a reconnecting
            # migration would, then check the lock is still held.
            connections[DEFAULT_DB_ALIAS].close()
            observed["still_held"] = not _lock_is_free()

        with patch(
            "boards.management.commands.migrate_with_lock.call_command",
            side_effect=_fake_migrate,
        ):
            call_command("migrate_with_lock", lock_timeout=5, stdout=StringIO())

        self.assertTrue(
            observed.get("still_held"),
            "closing the default connection released the migration lock — it is "
            "being held on the same connection migrate uses",
        )


@POSTGRES_ONLY
class RealMigrateTests(TransactionTestCase):
    """End to end, with the real `migrate`, on the already-migrated test database."""

    def test_applies_migrations_and_leaves_the_lock_free(self):
        out = StringIO()
        call_command("migrate_with_lock", lock_timeout=30, verbosity=0, stdout=out)

        self.assertIn("migrations applied", out.getvalue())
        self.assertTrue(_lock_is_free())
