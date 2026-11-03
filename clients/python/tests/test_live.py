"""Contract tests against a real Visiban backend (skipped unless configured).

Environment:
  VISIBAN_CONTRACT_BASE_URL   e.g. http://localhost:8000
  VISIBAN_CONTRACT_TOKEN_FILE file holding a PAT with the ``read`` and ``write`` scopes.
                              The client only issues GETs; write is for creating cards over
                              REST to produce events (provision_fuzz_token cannot mint a
                              read-only PAT).
  VISIBAN_CONTRACT_REQUIRED   ``1`` makes missing configuration a failure, not a skip (CI sets it)
  VISIBAN_CONTRACT_STATE      path where the feed phase leaves the cursor for the expired phase
  VISIBAN_CONTRACT_PHASE      ``feed`` (default) or ``expired``

CI runs ``feed``, then back-dates and prunes the board's events on the server,
then runs ``expired``. A change to the feed contract that breaks the client
fails this suite in the OSS pipeline.
"""

from __future__ import annotations

import json
import os
import unittest
import urllib.request
from pathlib import Path

from visiban_client import BadRequestError, Client, MemoryCursorStore, Resync

BASE = os.environ.get("VISIBAN_CONTRACT_BASE_URL")
TOKEN_FILE = os.environ.get("VISIBAN_CONTRACT_TOKEN_FILE")
# CI sets VISIBAN_CONTRACT_REQUIRED=1 so a missing or renamed variable fails the
# job instead of skipping every test. A plain local run (unset) still skips.
REQUIRED = os.environ.get("VISIBAN_CONTRACT_REQUIRED") == "1"
PHASE = os.environ.get("VISIBAN_CONTRACT_PHASE", "feed")
STATE = os.environ.get("VISIBAN_CONTRACT_STATE", "visiban-contract-state-python.json")


def _token() -> str:
    return Path(TOKEN_FILE).read_text().strip()


def _api(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        f"{BASE}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Token {_token()}", "Content-Type": "application/json"},
    )
    # CI-provided http URL, test code only.
    with urllib.request.urlopen(req, timeout=30) as resp:  # nosec B310
        return json.loads(resp.read())


@unittest.skipUnless((BASE and TOKEN_FILE) or REQUIRED, "live backend not configured")
class LiveFeedTests(unittest.TestCase):
    def setUp(self):
        if not (BASE and TOKEN_FILE):
            self.fail("VISIBAN_CONTRACT_BASE_URL and VISIBAN_CONTRACT_TOKEN_FILE must be set when VISIBAN_CONTRACT_REQUIRED=1")
        self.client = Client(BASE, _token(), allow_insecure=True)
        self.board_id = int(os.environ.get("VISIBAN_CONTRACT_BOARD_ID") or _api("GET", "/api/v1/boards/")["results"][0]["id"])

    def _head(self) -> int:
        cursor = 0
        for event in self.client.iter_events(self.board_id, limit=500):
            cursor = event["id"]
        return cursor

    @unittest.skipUnless(PHASE == "feed", "feed phase only")
    def test_paging_in_order_and_caught_up(self):
        head = self._head()
        full = _api("GET", f"/api/v1/boards/{self.board_id}/full/")
        column, swimlane = full["columns"][0]["id"], full["swimlanes"][0]["id"]
        for n in range(3):
            _api("POST", f"/api/v1/boards/{self.board_id}/cards/", {"title": f"contract {n}", "column": column, "swimlane": swimlane})
        store = MemoryCursorStore()
        # limit=1 forces one request per row, so every page boundary is exercised.
        events = list(self.client.iter_events(self.board_id, head, store=store, limit=1))
        ids = [e["id"] for e in events]
        self.assertGreaterEqual(len(ids), 3)
        self.assertEqual(ids, sorted(set(ids)), "ascending, no duplicates")
        self.assertTrue(all(i > head for i in ids))
        self.assertEqual({e["event"] for e in events} & {"card.created"}, {"card.created"})
        self.assertEqual(store.get(self.board_id), ids[-1])
        # Resuming from the committed cursor yields nothing: caught up.
        self.assertEqual(list(self.client.iter_events(self.board_id, store=store)), [])
        Path(STATE).write_text(json.dumps({"board_id": self.board_id, "cursor": ids[0]}))

    @unittest.skipUnless(PHASE == "feed", "feed phase only")
    def test_out_of_range_limit_is_a_400(self):
        with self.assertRaises(BadRequestError):
            self.client.fetch_page(self.board_id, 0, 501)

    @unittest.skipUnless(PHASE == "expired", "expired phase only")
    def test_expired_cursor_resyncs_then_resumes(self):
        state = json.loads(Path(STATE).read_text())
        store = MemoryCursorStore()
        items = list(self.client.iter_events(state["board_id"], state["cursor"], store=store))
        self.assertIsInstance(items[0], Resync)
        self.assertEqual(items[0].snapshot["id"], state["board_id"])
        self.assertIsInstance(items[0].cursor, int)
        self.assertGreaterEqual(items[0].cursor, state["cursor"])
        # Resuming from the 410's next_cursor does not 410 again.
        self.assertFalse(any(isinstance(i, Resync) for i in items[1:]))
        self.assertEqual(store.get(state["board_id"]), max([items[0].cursor] + [i["id"] for i in items[1:]]))


if __name__ == "__main__":
    unittest.main()
