#!/usr/bin/env python3
# gate-selftest-exempt: not a gate; a background diagnostic that only prints, its logic is tested in backend/boards/tests/test_pg_activity_watch_2536.py
"""Background Postgres activity watcher for CI backend test jobs (#2536).

Why it exists: ``backend-test`` shards intermittently hang in a SELECT that
takes under 1 ms when run alone (#2534, #2536). The query plan is ruled out,
so the suspect is a lock held by another connection, for example one an
earlier test leaked. The faulthandler dump only shows the client side; this
script records the server side: which backend is stuck, who blocks it, and
what the blocker is doing (an idle-in-transaction blocker is the key evidence).

DIAGNOSTIC ONLY. It never changes database state, never fails the job, and
prints at most one ``[pg-activity-watch]`` report per stuck pid to stderr.
It reads ``DATABASE_URL`` but never prints it.
"""

import os
import signal
import sys
import time
from urllib.parse import urlsplit, urlunsplit

PREFIX = "[pg-activity-watch]"
INTERVAL = 30
LONG_QUERY_SECONDS = 90
LOCK_WAIT_SECONDS = 60
QUERY_LIMIT = 500
COLS = "pid, datname, state, wait_event_type, wait_event, xact_start, query_start, query"

ACTIVITY_SQL = f"""
SELECT {COLS},
       EXTRACT(EPOCH FROM now() - query_start) AS query_age,
       pg_blocking_pids(pid) AS blockers
FROM pg_stat_activity
WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
"""
BACKEND_SQL = f"SELECT {COLS} FROM pg_stat_activity WHERE pid = ANY(%s)"
LOCKS_SQL = """
SELECT l.pid, l.locktype, l.mode, l.granted, c.relname
FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
WHERE l.pid = ANY(%s) AND (NOT l.granted OR l.pid = ANY(%s))
ORDER BY l.pid, l.granted
"""


def is_stuck(row):
    """Row is a dict from ACTIVITY_SQL; True when it meets a report threshold."""
    age = row.get("query_age")
    if age is None:
        return False
    # Only an *active* backend can be stuck. An "idle in transaction" backend (the
    # Django TestCase main connection between queries) is a blocker candidate, not a
    # stuck one; reporting it would also suppress the later real stall on that pid.
    if row.get("state") != "active":
        return False
    if age > LONG_QUERY_SECONDS:
        return True
    return row.get("wait_event_type") == "Lock" and age > LOCK_WAIT_SECONDS


def should_report(row, reported):
    """True when ``row`` is stuck and its (pid, query_start) was not yet reported.

    Keyed on query_start, not pid, so a later stall on a reused connection is
    still reported.
    """
    return is_stuck(row) and (row["pid"], row.get("query_start")) not in reported


def describe(row):
    query = " ".join(str(row.get("query") or "").split())[:QUERY_LIMIT]
    return (
        f"pid={row.get('pid')} db={row.get('datname')} state={row.get('state')} "
        f"wait={row.get('wait_event_type')}/{row.get('wait_event')} "
        f"xact_start={row.get('xact_start')} query_start={row.get('query_start')} "
        f"query={query!r}"
    )


def format_report(stuck, blockers, locks):
    """Pure: dict rows in, report text out. ``blockers`` are dict rows of blocking pids."""
    lines = [f"{PREFIX} stuck backend: {describe(stuck)}"]
    lines.append(f"{PREFIX} blocked by pids: {list(stuck.get('blockers') or []) or 'none (not a lock wait)'}")
    for row in blockers:
        lines.append(f"{PREFIX} blocker: {describe(row)}")
    for lock in locks:
        lines.append(
            f"{PREFIX} lock: pid={lock['pid']} {lock['locktype']} {lock['mode']} "
            f"granted={lock['granted']} relation={lock.get('relname')}"
        )
    return "\n".join(lines)


def maintenance_dsn(url):
    """Same server and credentials as DATABASE_URL, but the ``postgres`` database."""
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path="/postgres"))


def collect(conn, row):
    from psycopg.rows import dict_row

    blocking = list(row.get("blockers") or [])
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(BACKEND_SQL, (blocking,))
        blockers = cur.fetchall()
        cur.execute(LOCKS_SQL, ([row["pid"], *blocking], blocking))
        return blockers, cur.fetchall()


def main():
    import psycopg
    from psycopg.rows import dict_row

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        print(f"{PREFIX} DATABASE_URL not set; watcher not started", file=sys.stderr)
        return 0
    dsn = maintenance_dsn(url)
    reported = set()
    while True:
        try:
            with psycopg.connect(dsn, autocommit=True, connect_timeout=10) as conn:
                while True:
                    with conn.cursor(row_factory=dict_row) as cur:
                        cur.execute(ACTIVITY_SQL)
                        rows = cur.fetchall()
                    for row in rows:
                        if not should_report(row, reported):
                            continue
                        reported.add((row["pid"], row.get("query_start")))
                        blockers, locks = collect(conn, row)
                        print(format_report(row, blockers, locks), file=sys.stderr, flush=True)
                    time.sleep(INTERVAL)
        except Exception as exc:  # diagnostic only: never take the job down
            print(f"{PREFIX} {type(exc).__name__}; retrying in {INTERVAL}s", file=sys.stderr, flush=True)
            time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
