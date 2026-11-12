# visiban-client (Python)

**Experimental (0.x), not published.** A thin client for the Visiban change feed
([`docs/api/events.md`](../../docs/api/events.md)): it holds a cursor, pages
`GET /api/v1/boards/{id}/events/`, and turns a `410 cursor_expired` into a typed
`Resync`. It is not a general REST SDK. Standard library only; Python 3.10+.

Requires **Visiban server 1.3 or later**. A 1.2 server's `410` has no
`next_cursor`, so the client raises `ResyncUnsupported` instead of guessing.

## Install

The package is not on PyPI. Install from a checkout, or from the Git subdirectory:

```bash
pip install ./clients/python
pip install "git+https://gitlab.com/visiban/visiban.git#subdirectory=clients/python"
```

## Use

```python
from visiban_client import Client, MemoryCursorStore, Resync

client = Client("https://visiban.example.com", token)  # PAT with the `read` scope
store = MemoryCursorStore()                            # or your own CursorStore

for item in client.iter_events(board_id, store=store, poll_interval=5):
    if isinstance(item, Resync):
        replace_local_state(item.snapshot)   # the /full/ board state
    else:
        handle(item)                         # a feed row (dict), passed through verbatim
```

- **At-least-once.** The stored cursor advances when you ask for the *next*
  item, after your loop body returned. A `break` or an exception leaves that item
  uncommitted. To redeliver it, call `iter_events` again (a new iterator over the
  same store); do not resume the old generator after an exception, because it
  would treat the failed item as handled and commit it. Make handlers idempotent;
  there is no exactly-once mode.
- **Resync.** On `410` the client keeps the response's `next_cursor`, fetches
  `/full/` (using only the path of `resync_url`, with your configured origin),
  and yields `Resync(board_id, snapshot, cursor)`. The cursor moves to
  `resync.cursor` after your body returns. An event can appear in both the
  snapshot and the resumed feed.
- **Reconnect cursor.** Resume only from a cursor the feed handed you
  (`next_cursor`), never from the `event_id` of a WebSocket frame. Frames can
  arrive out of `event_id` order, so a frame's id can be past an event that is
  still committing; the feed's cursor never is ([#2159](https://gitlab.com/visiban/visiban/-/issues/2159)).
  This client has no socket code and only ever resumes from the feed cursor.
- **Bootstrap a first cursor.** `/full/` carries no event id and `after=0`
  never returns `410`. For a socket consumer, drain the feed first and discard
  the rows (`for _ in client.iter_events(board_id, store=store, limit=500): pass`), so the
  store holds the newest id; then open the socket and fetch `/full/`. Do not
  apply 30 days of history over a fresh snapshot. Events committed after that
  cursor may repeat over the snapshot, and your client never applied their ids, so apply them idempotently. `limit=500` is the maximum page size; draining costs one request per 500 retained rows against a production 5000-per-hour user throttle. An empty first page does not prove the feed is empty (a write in flight, such as a long import, also gives one): read again after a short delay before taking 0 as the cursor. A long-connected socket consumer should also read the feed now and then to move the cursor forward.
- **Caught up** means the server's `next_cursor` was `null`; the client never
  counts rows.
- **Cursor store.** Any object with `get(board_id) -> int | None` and
  `set(board_id, cursor)` (the `CursorStore` protocol). Make `set` durable if you
  need to survive restarts.
- **Polling.** `poll_interval=None` (default) returns once caught up; a number of
  seconds sleeps and polls forever.
- **Retries.** 429, 5xx and network errors back off exponentially (`Retry-After`
  honored, capped by `backoff_max`); 400/401/403/404 raise typed errors at once.
- **Late-committing rows.** Event ids follow insertion order, not commit order.
  A Visiban 1.3 or later server never hands out a page that reaches past an
  event still committing ([#2053](https://gitlab.com/visiban/visiban/-/issues/2053)),
  so reads against it are gap-free with no overlap option. Against an earlier
  server a read can step past a row that commits a moment later.
- **Auth.** A scoped personal access token (`read` is enough; the client only
  issues GETs), sent only to the host in `base_url`. Redirects are never followed,
  and plain `http://` to a non-loopback host is refused unless
  `allow_insecure=True`. `urllib` honors `HTTP_PROXY` / `HTTPS_PROXY`, so the
  token travels through a configured proxy (readable by it over plain `http`):
  use `https` and check the environment.
- **Default store.** Without `store=`, each `iter_events` call gets a fresh
  `MemoryCursorStore`, so a bare call replays from 0. Reuse one store (or pass
  `cursor=`) to resume.

## Webhook signatures (experimental)

```python
from visiban_client import verify_signature

ok = verify_signature(secret, request.headers, raw_body_bytes)  # False on any failure
```

During a secret rotation the signature header can list two values
(`v1=<new>,v1=<old>`); the check accepts a request when any value matches, so a
receiver holds one secret and needs no second setting. Earlier copies of this
package compared the whole header and reject those requests: upgrade before
rotating with an overlap.

Pass the unparsed request body. Experimental until the webhooks API is stable
([#2070](https://gitlab.com/visiban/visiban/-/issues/2070)).

## Tests

```bash
cd clients/python
PYTHONPATH=src python -m unittest discover -s tests -t .
```

`tests/test_contract_fixtures.py` and `tests/test_webhooks.py` run the shared
cases in [`clients/contract/fixtures.json`](../contract/fixtures.json); the
TypeScript suite runs the same file. `tests/test_live.py` runs against a real
backend when `VISIBAN_CONTRACT_BASE_URL` and `VISIBAN_CONTRACT_TOKEN_FILE` are set
(CI does this in the `clients-contract` job).

Apache 2.0, same as Visiban.
