"""Apply Django migrations under a session-scoped PostgreSQL advisory lock (#1117).

Why this exists
---------------
The Helm chart used to migrate from a ``pre-install,pre-upgrade`` hook Job. Helm
runs pre-install hooks *before* it creates any release resource, so on a fresh
install the hook resolved the bundled PostgreSQL Service before that Service
existed and `helm install` could never succeed (#1117). Moving migrations into
an init container on the backend Deployment removes the hook-ordering problem
entirely — an init container starts after Helm has applied the whole release —
but it reintroduces the one the hook Job was chosen to avoid: with
``backendReplicaCount > 1`` every replica's init container would run ``migrate``
at the same time.

This command is what makes that safe. It is the serialization the chart's old
design note said did not exist.

The lock, and why this shape
----------------------------
``pg_advisory_lock`` / ``pg_try_advisory_lock`` take a cluster-global, *database*
-scoped lock on an arbitrary key. Three properties make them the right primitive
here, and each one rules out an alternative that looks equivalent:

1. **Session-scoped, not transaction-scoped.** ``migrate`` runs each migration in
   its own transaction, so ``pg_advisory_xact_lock`` could not span a whole
   migrate run — it would be released at the first commit and the next replica
   would join mid-run. A session lock is held until it is explicitly unlocked or
   the session ends.

2. **Released automatically when the holder dies.** PostgreSQL drops every
   advisory lock held by a session when that backend process exits, including
   when the holder is OOM-killed, its node is lost, or the pod is deleted
   mid-migration — the TCP connection dies and the server reaps the session. So
   a crashed migration cannot wedge every later deploy, which is the failure
   mode a lock table or an advisory *row* would have.

3. **Held on a dedicated connection.** The lock is taken on a connection created
   solely for that purpose, never on the connection ``migrate`` itself uses.
   Anything ``migrate`` does to its own connection — a non-atomic migration that
   closes and reopens it, a backend that reconnects after an error — would
   silently drop a lock held there, and the drop would be invisible: the
   migration would simply continue with no mutual exclusion at all.

A replica that loses the race does not skip migrations and start anyway. It
blocks on the lock, and when it finally acquires it runs ``migrate`` — which is a
no-op, because ``django_migrations`` already records everything the winner
applied. So no pod ever starts its application container against a schema that is
still being changed.

The wait is a bounded ``pg_try_advisory_lock`` poll rather than a blocking
``pg_advisory_lock`` so that a genuinely stuck holder surfaces as a named error
with a timeout in it, instead of an init container that hangs forever and says
nothing.

Non-PostgreSQL databases (SQLite in local development and in this repo's own
test runs) have no advisory locks and no multi-replica deployment story; the lock
is skipped there and ``migrate`` runs directly.
"""

from __future__ import annotations

import os
import time

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import DEFAULT_DB_ALIAS, OperationalError, connections

# Fixed forever. Advisory-lock keys are namespaced by database, so two Visiban
# installs in two databases never collide, and two releases pointed at ONE
# database are meant to collide — that is the whole point. Written as a literal
# rather than derived from a name (hash of "visiban-migrate", say) because a
# derived key silently changes the moment the name it derives from is edited,
# and a changed key is a lock that protects nothing while looking like it does.
MIGRATION_LOCK_KEY = 4816721117

# How long to wait for the database to accept a connection at all. Generous: on a
# fresh `helm install` the bundled PostgreSQL StatefulSet is being scheduled,
# pulled and initialized at the same moment this container first runs.
DEFAULT_CONNECT_TIMEOUT = 300

# How long to wait for another replica's in-flight migration to finish. Larger
# than the connect timeout because the thing being waited on is a real migration
# run, which on a large `cards` table is minutes, not seconds.
DEFAULT_LOCK_TIMEOUT = 900

# Poll intervals. Short enough that a fast start is not padded by a fixed sleep,
# long enough not to spin.
CONNECT_POLL_SECONDS = 2
LOCK_POLL_SECONDS = 2


def _positive_int(raw: str, default: int) -> int:
    """Coerce `raw` to a positive integer, falling back on `default`.

    Takes the already-read string rather than the variable's name so that every
    environment lookup in this file is a LITERAL `os.environ.get("NAME")` at its
    call site. scripts/helm-structure-check.sh section 3 asserts that every env
    var the chart injects is looked up somewhere under backend/, and it matches
    the literal — a helper that reads `os.environ.get(name)` through a parameter
    is invisible to it, which is how an injected-but-unread variable (#1038
    blocker 1) gets back in.

    A malformed value falls back rather than crashing: this runs as the first
    init container of every backend pod, and refusing to start the whole
    deployment over a typo in a tuning knob is a worse outcome than using the
    default.
    """
    if not raw:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


class Command(BaseCommand):
    help = (
        "Run `migrate` under a session-scoped PostgreSQL advisory lock so that "
        "concurrent backend replicas cannot apply migrations at the same time."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--connect-timeout",
            type=int,
            default=None,
            help=(
                "Seconds to wait for the database to accept connections "
                f"(env VISIBAN_MIGRATE_CONNECT_TIMEOUT, default {DEFAULT_CONNECT_TIMEOUT})."
            ),
        )
        parser.add_argument(
            "--lock-timeout",
            type=int,
            default=None,
            help=(
                "Seconds to wait for another replica's migration to finish "
                f"(env VISIBAN_MIGRATE_LOCK_TIMEOUT, default {DEFAULT_LOCK_TIMEOUT})."
            ),
        )

    def handle(self, *args, **options):
        connect_timeout = options.get("connect_timeout")
        if connect_timeout is None:
            connect_timeout = _positive_int(
                os.environ.get("VISIBAN_MIGRATE_CONNECT_TIMEOUT", ""),
                DEFAULT_CONNECT_TIMEOUT,
            )
        lock_timeout = options.get("lock_timeout")
        if lock_timeout is None:
            lock_timeout = _positive_int(
                os.environ.get("VISIBAN_MIGRATE_LOCK_TIMEOUT", ""),
                DEFAULT_LOCK_TIMEOUT,
            )

        verbosity = options.get("verbosity", 1)

        self._wait_for_database(connect_timeout)

        if connections[DEFAULT_DB_ALIAS].vendor != "postgresql":
            # SQLite (local development, this repo's test runs) has no advisory
            # locks — and no multi-replica deployment to protect against.
            self.stdout.write(
                "migrate_with_lock: database vendor is "
                f"'{connections[DEFAULT_DB_ALIAS].vendor}', which has no advisory locks — "
                "running migrate without one."
            )
            call_command("migrate", interactive=False, verbosity=verbosity)
            return

        # create_connection() builds a wrapper from the `default` alias's settings
        # WITHOUT registering it in the handler, which is exactly what is wanted:
        # `migrate` keeps using connections["default"], and nothing it does to
        # that connection can touch the session holding the lock.
        lock_conn = connections.create_connection(DEFAULT_DB_ALIAS)
        try:
            self._acquire_lock(lock_conn, lock_timeout)
            self.stdout.write("migrate_with_lock: lock held, applying migrations")
            call_command("migrate", interactive=False, verbosity=verbosity)
            self.stdout.write("migrate_with_lock: migrations applied")
        finally:
            # close() alone would end the session and so release the lock, but
            # unlocking explicitly keeps the intent legible and releases it even
            # if close() is slow to be noticed by the server.
            self._release_lock(lock_conn)
            lock_conn.close()

    # -- internals ---------------------------------------------------------

    def _wait_for_database(self, timeout: int) -> None:
        """Block until the database answers, or fail with a message naming the wait.

        On a fresh `helm install` this container can start before the PostgreSQL
        pod is scheduled, so "host not found" is an expected transient state, not
        an error. It only becomes an error when it outlives `timeout`.
        """
        deadline = time.monotonic() + timeout
        attempts = 0
        while True:
            attempts += 1
            connection = connections[DEFAULT_DB_ALIAS]
            try:
                connection.ensure_connection()
                if attempts > 1:
                    self.stdout.write(
                        f"migrate_with_lock: database reachable after {attempts} attempts"
                    )
                return
            except OperationalError as exc:
                # Drop the half-open wrapper so the next attempt genuinely
                # reconnects instead of reusing a dead handle.
                connection.close()
                if time.monotonic() >= deadline:
                    # `exc` carries the host and the failure reason, never the
                    # password — psycopg does not echo the DSN. Nothing here
                    # renders settings.DATABASES or DATABASE_URL itself.
                    raise CommandError(
                        f"migrate_with_lock: the database did not accept a connection within "
                        f"{timeout}s ({attempts} attempts). Last error: {exc}"
                    ) from exc
                time.sleep(CONNECT_POLL_SECONDS)

    def _acquire_lock(self, lock_conn, timeout: int) -> None:
        """Take the migration advisory lock, waiting up to `timeout` seconds."""
        deadline = time.monotonic() + timeout
        waited = False
        while True:
            with lock_conn.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_lock(%s)", [MIGRATION_LOCK_KEY])
                acquired = cursor.fetchone()[0]
            if acquired:
                if waited:
                    self.stdout.write(
                        "migrate_with_lock: the other replica finished; lock acquired"
                    )
                return
            if time.monotonic() >= deadline:
                raise CommandError(
                    f"migrate_with_lock: another process has held the migration lock for more "
                    f"than {timeout}s. Refusing to start the application against a schema that "
                    "may be half-migrated. Check the other backend pods' migrate init "
                    "containers, then retry."
                )
            if not waited:
                waited = True
                self.stdout.write(
                    "migrate_with_lock: another replica is migrating — waiting for it to finish"
                )
            time.sleep(LOCK_POLL_SECONDS)

    def _release_lock(self, lock_conn) -> None:
        """Release the advisory lock, tolerating a connection that is already gone.

        Never raises: this runs in a `finally`, and masking the real migration
        failure with an unlock error would hide the thing the operator needs.
        Closing the session releases the lock regardless.
        """
        try:
            with lock_conn.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_unlock(%s)", [MIGRATION_LOCK_KEY])
        except Exception as exc:  # noqa: BLE001 — see docstring
            self.stderr.write(
                f"migrate_with_lock: could not release the advisory lock explicitly ({exc}); "
                "closing the session releases it."
            )
