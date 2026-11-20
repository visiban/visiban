#!/usr/bin/env python3
"""Fail if the email-login lookup stops using ``user_email_upper_idx`` (#1298).

``accounts.backends.resolve_login_user`` runs ``email__iexact`` on every
anonymous email login. #1222 added ``user_email_upper_idx`` (an ``UPPER(email)``
expression index) for it, but its committed plan test runs against a 1-row
table with ``enable_seqscan = off``: that proves the index is *usable*, not that
the planner *picks* it at a realistic size. Latency cannot catch the
regression either: a successful login is dominated by two password hashes
(hundreds of ms), which hide a 2-3 ms sequential scan at 20k users.

So this check asserts the plan, not the latency. Against the nightly job's
PostgreSQL database it
  1. tops the users table up to ``--users`` rows (default 20,000) and ANALYZEs it,
  2. runs the real ``resolve_login_user`` for an email whose case differs from
     the stored one and captures the SQL it issues (so a lookup rewritten to
     ``LOWER`` or ``icontains`` is what gets planned, not a copy of today's),
  3. EXPLAINs that statement with default planner settings and fails unless the
     plan names ``user_email_upper_idx`` and has no sequential scan on the users
     table.

It runs after the latency scenarios in the ``nightly-load-test`` job so the
added users cannot move any budgeted number. Throwaway CI database only.

Usage (from the ``backend`` directory, DATABASE_URL pointing at PostgreSQL):
    python ../scripts/check_email_login_plan.py [--users 20000]
    python scripts/check_email_login_plan.py --self-test   # no database
"""

import argparse
import os
import re
import sys
import time

INDEX_NAME = "user_email_upper_idx"
BULK_PREFIX = "loadtest-email-"
BATCH = 2000


def _plan_verdict(plan_text, table):
    """Return a list of problems with an EXPLAIN plan (empty means good)."""
    problems = []
    if INDEX_NAME not in plan_text:
        problems.append(f"plan does not use {INDEX_NAME}")
    if re.search(rf"Seq Scan on {re.escape(table)}\b", plan_text):
        problems.append(f"plan has a sequential scan on {table}")
    return problems


def _self_test():
    """Prove _plan_verdict still flags a seq scan and passes an index scan."""
    failures = []
    good = (
        "Limit  (cost=0.29..8.31 rows=1)\n"
        "  ->  Index Scan using user_email_upper_idx on users  (cost=0.29..8.31)\n"
        "        Index Cond: (upper((email)::text) = 'X'::text)\n"
    )
    bitmap = (
        "Bitmap Heap Scan on users\n"
        "  ->  Bitmap Index Scan on user_email_upper_idx\n"
    )
    seq = (
        "Limit  (cost=0.00..600.00 rows=1)\n"
        "  ->  Seq Scan on users  (cost=0.00..600.00)\n"
        "        Filter: (upper((email)::text) = 'X'::text)\n"
    )
    # Names the index (so the first clause passes) AND seq-scans users: only the
    # seq-scan clause can flag this one.
    index_and_seq = (
        "Index Scan using user_email_upper_idx on users\n"
        "  ->  Seq Scan on users  (cost=0.00..600.00)\n"
    )
    other_index = "Index Scan using users_email_key on users\n"
    if _plan_verdict(good, "users"):
        failures.append("KNOWN-GOOD index scan was flagged")
    if _plan_verdict(bitmap, "users"):
        failures.append("KNOWN-GOOD bitmap index scan was flagged")
    if not _plan_verdict(seq, "users"):
        failures.append("KNOWN-BAD seq scan was not flagged")
    if not _plan_verdict(index_and_seq, "users"):
        failures.append("KNOWN-BAD plan naming the index plus a seq scan was not flagged")
    if not _plan_verdict(other_index, "users"):
        failures.append("KNOWN-BAD plan using a different index was not flagged")
    if failures:
        for msg in failures:
            print(f"SELF-TEST FAIL: {msg}", file=sys.stderr)
        return 1
    print("check_email_login_plan self-test: OK")
    return 0


def _django_setup():
    backend = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
    sys.path.insert(0, os.path.abspath(backend))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
    import django

    django.setup()


def run(users):
    _django_setup()
    from django.db import connection
    from django.test.utils import CaptureQueriesContext
    from psycopg import sql as pg_sql

    from accounts.backends import resolve_login_user
    from accounts.models import User

    if connection.vendor != "postgresql":
        print("FAIL: the plan check needs PostgreSQL (set DATABASE_URL).", file=sys.stderr)
        return 1

    existing = User.objects.count()
    missing = max(0, users - existing)
    for start in range(existing, existing + missing, BATCH):
        stop = min(start + BATCH, existing + missing)
        User.objects.bulk_create(
            [
                User(
                    username=f"{BULK_PREFIX}{i:07d}",
                    email=f"Load.Test.{i:07d}@Example.com",
                    password="!",  # unusable: these accounts never log in
                )
                for i in range(start, stop)
            ],
            ignore_conflicts=True,
        )
    with connection.cursor() as cur:
        # psycopg composes the identifier itself; no string formatting of SQL.
        cur.execute(pg_sql.SQL("ANALYZE {}").format(pg_sql.Identifier(User._meta.db_table)))
    total = User.objects.count()
    print(f"users table: {total} rows (added {missing}); ANALYZE done")
    if total < users:
        print(f"FAIL: users table has {total} rows, expected at least {users}.", file=sys.stderr)
        return 1

    # Different case from the stored address, so only an email lookup resolves it.
    identifier = f"load.test.{total // 2:07d}@example.com"
    if User.objects.filter(email=identifier).exists():
        print("FAIL: the probe email must differ in case from the stored one.", file=sys.stderr)
        return 1
    with CaptureQueriesContext(connection) as ctx:
        resolved = resolve_login_user(identifier)
    if resolved is None:
        print(f"FAIL: resolve_login_user({identifier!r}) found no account; the fixture is wrong.", file=sys.stderr)
        return 1
    # Only the statement that filters on email: the username probe that runs first
    # selects the email column too, so look at the WHERE clause alone.
    email_sql = [
        q["sql"] for q in ctx.captured_queries
        if " WHERE " in q["sql"] and "email" in q["sql"].split(" WHERE ", 1)[1].lower()
    ]
    if not email_sql:
        print("FAIL: no email lookup SQL was captured from resolve_login_user.", file=sys.stderr)
        return 1

    table = User._meta.db_table
    rc = 0
    for sql in email_sql:
        with connection.cursor() as cur:
            cur.execute("EXPLAIN " + sql)
            plan = "\n".join(row[0] for row in cur.fetchall())
        print(f"--- plan for: {sql[:160]}\n{plan}")
        for problem in _plan_verdict(plan, table):
            print(f"FAIL: {problem}", file=sys.stderr)
            rc = 1

    timings = []
    for _ in range(100):
        t0 = time.perf_counter()
        resolve_login_user(identifier)
        timings.append((time.perf_counter() - t0) * 1000)
    timings.sort()
    print(f"resolve_login_user at {total} users: p50={timings[49]:.2f}ms p95={timings[94]:.2f}ms")
    if rc == 0:
        print(f"OK: the email login lookup uses {INDEX_NAME} at {total} users.")
    return rc


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--users", type=int, default=20000, help="Minimum users-table size (default: 20000).")
    parser.add_argument("--self-test", action="store_true", help="Prove the plan check fires, then exit (no database).")
    args = parser.parse_args()
    if args.self_test:
        sys.exit(_self_test())
    sys.exit(run(args.users))


if __name__ == "__main__":
    main()
