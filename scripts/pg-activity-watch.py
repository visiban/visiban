#!/usr/bin/env python3
# gate-selftest-exempt: not a gate; a background diagnostic that only prints, its logic is tested in backend/boards/tests/test_pg_activity_watch_2536.py
"""Background Postgres activity watcher for CI backend test jobs (#2536).

Why it exists: ``backend-test`` shards intermittently hang in a SELECT that
takes under 1 ms when run alone (#2534, #2536). The faulthandler dump only
shows the client side; this script records the server side: which backend is
stuck, who blocks it, and what the blocker is doing.

The first report (main pipeline 3105471449, 2026-11-23) ruled a lock OUT: the
stuck backend was ``state=active wait=None/None`` with no blockers, and the
same zero-row statement ran for minutes several times in a row, so the server
was busy on CPU. For that case (active, no wait event) the report now adds
the PLAN of the stuck statement: ``EXPLAIN`` (never ``ANALYZE``, so nothing
runs) of the same text, on the same database, from a read-only connection
with a statement timeout. It also says how long planning took, which tells a
planner stall from an executor one, the plan's total cost against the JIT
thresholds, and the planner statistics of the tables involved. CI raises
``track_activity_query_size`` so the full statement text is available.

DIAGNOSTIC ONLY. It never changes database state, never fails the job, and
prints at most one ``[pg-activity-watch]`` report per stuck query (pid, query_start) to stderr.
It reads ``DATABASE_URL`` but never prints it.

The EXPLAIN connection is to the TEST database, which the shard drops at
teardown, and a session left open makes that ``DROP DATABASE`` fail ("being
accessed by other users"). So the connection is bounded (5 s connect, 20 s
statement timeout; a planner stall past that is itself reported as the
finding) and always closed in a ``finally`` before the report returns.
"""

import os
import re
import signal
import sys
import time
from urllib.parse import urlsplit, urlunsplit

PREFIX = "[pg-activity-watch]"
INTERVAL = 30
LONG_QUERY_SECONDS = 90
LOCK_WAIT_SECONDS = 60
QUERY_LIMIT = 500
#: Upper bound on the diagnostic EXPLAIN. Planning that runs past it is itself
#: the finding (a planner stall), reported as such.
EXPLAIN_TIMEOUT_MS = 20_000
#: Connect bound for the diagnostic connection to the TEST database. Together
#: with ``EXPLAIN_TIMEOUT_MS`` the connection lives at most about 25 s (plus the
#: two cheap catalog reads): it is always closed in a ``finally``. The timeouts
#: only bound the window to about 25 s, they do not remove it: a shard teardown
#: inside that window can still meet the open session, and Django's
#: ``DROP DATABASE`` fails with "being accessed by other users" while any
#: session is open. This is a reduced risk, not an eliminated one.
EXPLAIN_CONNECT_TIMEOUT_S = 5
#: Tables whose planner statistics are printed with a plan, at most.
STATS_TABLE_LIMIT = 20
# Plain literals, never f-strings: every value reaches Postgres as a bound
# parameter, and SAST (bandit B608) flags any formatted SQL string.
ACTIVITY_SQL = """
SELECT pid, datname, state, wait_event_type, wait_event, xact_start, query_start, query,
       EXTRACT(EPOCH FROM now() - query_start) AS query_age,
       pg_blocking_pids(pid) AS blockers
FROM pg_stat_activity
WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
"""
BACKEND_SQL = """
SELECT pid, datname, state, wait_event_type, wait_event, xact_start, query_start, query
FROM pg_stat_activity WHERE pid = ANY(%s)
"""
TABLE_STATS_SQL = """
SELECT s.relname, c.reltuples::bigint AS reltuples, c.relpages, pg_relation_size(c.oid) / 8192 AS curpages,
       s.n_live_tup, s.n_dead_tup, s.last_autoanalyze, s.last_analyze, s.last_autovacuum
FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
WHERE s.relname = ANY(%s) ORDER BY s.relname
"""
JIT_SQL = """
SELECT current_setting('jit') AS jit, current_setting('jit_above_cost') AS above,
       current_setting('jit_optimize_above_cost') AS optimize, current_setting('jit_inline_above_cost') AS inline
"""
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


def wants_plan(row):
    """True for a stall with no wait event: on CPU (planning or executing), not waiting."""
    return row.get("state") == "active" and not row.get("wait_event_type") and not (row.get("blockers") or [])


def explainable(query):
    """The statement text when it is safe and complete to EXPLAIN, else None.

    Only a single SELECT: EXPLAIN without ANALYZE never runs a statement, but a
    diagnostic has no business planning writes. A text cut at
    ``track_activity_query_size`` does not parse; its EXPLAIN is reported as
    failed with ``SyntaxError``, which is the cue to raise that setting.
    """
    text = str(query or "").strip().rstrip(";").strip()
    if not text.upper().startswith("SELECT ") or ";" in text:
        return None
    return text


_TABLE_RE = re.compile(r'(?:FROM|JOIN)\s+"([A-Za-z0-9_]+)"')


def table_names(query):
    """Quoted table names after FROM/JOIN in a Django statement, sorted and deduped."""
    return sorted(set(_TABLE_RE.findall(str(query or ""))))[:STATS_TABLE_LIMIT]


def format_plan(plan_lines, seconds, jit, stats, error=None):
    """Pure: the plan section of a report."""
    lines = []
    if error is not None:
        lines.append(f"{PREFIX} plan: EXPLAIN failed after {seconds:.1f}s: {error}")
    else:
        lines.append(f"{PREFIX} plan: EXPLAIN (plan only) took {seconds:.3f}s")
        for line in plan_lines:
            lines.append(f"{PREFIX} plan| {line}")
    if jit:
        lines.append(
            f"{PREFIX} jit={jit['jit']} above_cost={jit['above']} optimize_above={jit['optimize']} "
            f"inline_above={jit['inline']}"
        )
    for t in stats:
        lines.append(
            f"{PREFIX} stats: {t['relname']} reltuples={t['reltuples']} relpages={t['relpages']} "
            f"curpages={t['curpages']} live={t['n_live_tup']} dead={t['n_dead_tup']} "
            f"autoanalyze={t['last_autoanalyze']} analyze={t['last_analyze']} autovacuum={t['last_autovacuum']}"
        )
    return "\n".join(lines)


def database_dsn(url, dbname):
    """Same server and credentials as DATABASE_URL, on database ``dbname``."""
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{dbname}"))


def plan_report(url, row):
    """EXPLAIN the stuck statement on its own database; never raises."""
    import psycopg
    from psycopg.rows import dict_row

    query = explainable(row.get("query"))
    if query is None:
        return f"{PREFIX} plan: skipped (not a single SELECT)"
    started = time.monotonic()
    conn = None
    try:
        conn = psycopg.connect(
            database_dsn(url, row["datname"]), autocommit=True, connect_timeout=EXPLAIN_CONNECT_TIMEOUT_S,
            options=f"-c default_transaction_read_only=on -c statement_timeout={EXPLAIN_TIMEOUT_MS}",
        )
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(JIT_SQL)
            jit = cur.fetchone()
            cur.execute(TABLE_STATS_SQL, (table_names(query),))
            stats = cur.fetchall()
            started = time.monotonic()
            # The statement text is the stuck backend's own, read back from
            # pg_stat_activity, never user input; EXPLAIN without ANALYZE does
            # not execute it, and the connection is read-only.
            cur.execute("EXPLAIN (COSTS, SETTINGS) " + query)
            plan = [r["QUERY PLAN"] for r in cur.fetchall()]
            return format_plan(plan, time.monotonic() - started, jit, stats)
    except Exception as exc:  # diagnostic only
        return format_plan([], time.monotonic() - started, None, [], error=type(exc).__name__)
    finally:
        # Always release the session: it is on the test database, and an open
        # one fails the shard's DROP DATABASE at teardown.
        if conn is not None:
            try:
                conn.close()
            except Exception:  # diagnostic only
                pass


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
                        if wants_plan(row):
                            print(plan_report(url, row), file=sys.stderr, flush=True)
                    time.sleep(INTERVAL)
        except Exception as exc:  # diagnostic only: never take the job down
            print(f"{PREFIX} {type(exc).__name__}; retrying in {INTERVAL}s", file=sys.stderr, flush=True)
            time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
