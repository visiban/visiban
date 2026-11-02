"""Runs every scenario in clients/contract/fixtures.json against the client.

The TypeScript suite runs the same scenarios and expectations, so a behavior
difference between the two languages fails one of them.
"""

from __future__ import annotations

import unittest

import visiban_client as vc
from visiban_client import Client, MemoryCursorStore, Resync

from .helpers import ScriptedServer, load_fixtures

FIXTURES = load_fixtures()


class _Stop(Exception):
    pass


class RecordingStore(MemoryCursorStore):
    def __init__(self, initial=None, board_id=None):
        super().__init__()
        self.commits: list[int] = []
        if initial is not None:
            super().set(board_id, initial)

    def set(self, board_id, cursor):
        self.commits.append(cursor)
        super().set(board_id, cursor)


def run_scenario(case: dict) -> None:
    opts = case["options"]
    exp = case["expected"]
    sleeps: list[float] = []
    stop_after = opts.get("stop_after_sleeps")

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        if stop_after is not None and len(sleeps) >= stop_after:
            raise _Stop

    store = RecordingStore(opts.get("store_initial"), opts["board_id"])
    items: list = []
    error = None
    with ScriptedServer(case["responses"]) as server:
        client = Client(
            server.url,
            "vbn_test_token",
            sleep=sleep,
            jitter=False,
            max_retries=opts.get("max_retries", 5),
        )
        kwargs = {"store": store, "overlap": opts.get("overlap", 0)}
        if "limit" in opts:
            kwargs["limit"] = opts["limit"]
        if "cursor" in opts:
            kwargs["cursor"] = opts["cursor"]
        if "poll_interval_s" in opts:
            kwargs["poll_interval"] = opts["poll_interval_s"]
        try:
            for item in client.iter_events(opts["board_id"], **kwargs):
                items.append(item)
                if opts.get("break_after") and len(items) >= opts["break_after"]:
                    break
        except _Stop:
            pass
        except vc.VisibanError as exc:
            error = type(exc).__name__
        requests = [{"path": r["path"], "query": r["query"]} for r in server.requests]
        auth = {r["authorization"] for r in server.requests}

    summary = [["resync", i.cursor] if isinstance(i, Resync) else ["event", i["id"]] for i in items]
    assert summary == exp["items"], (summary, exp["items"])
    assert requests == exp["requests"], (requests, exp["requests"])
    assert store.commits == exp["commits"], (store.commits, exp["commits"])
    assert sleeps == exp["sleeps_s"], (sleeps, exp["sleeps_s"])
    assert error == exp["error"], (error, exp["error"])
    assert auth <= {"Token vbn_test_token"}
    # Rows pass through verbatim, unknown fields and redactions included.
    sent = {
        e["id"]: e
        for r in case["responses"]
        if isinstance(r.get("body"), dict)
        for e in r["body"].get("results", [])
    }
    for item in items:
        if isinstance(item, Resync):
            assert item.snapshot == exp["resync_snapshot"]
        else:
            assert item == sent[item["id"]]


class ContractFixtureTests(unittest.TestCase):
    pass


def _make(case):
    def test(self):
        run_scenario(case)

    return test


for _case in FIXTURES["scenarios"]:
    setattr(ContractFixtureTests, f"test_{_case['name']}", _make(_case))


if __name__ == "__main__":
    unittest.main()
