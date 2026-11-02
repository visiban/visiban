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
  uncommitted, so it is delivered again. Make handlers idempotent; there is no
  exactly-once mode.
- **Resync.** On `410` the client keeps the response's `next_cursor`, fetches
  `/full/` (using only the path of `resync_url`, with your configured origin),
  and yields `Resync(board_id, snapshot, cursor)`. The cursor moves to
  `resync.cursor` after your body returns. An event can appear in both the
  snapshot and the resumed feed.
- **Caught up** means `next_cursor` was `null`, never a short page.
- **Cursor store.** Any object with `get(board_id) -> int | None` and
  `set(board_id, cursor)` (the `CursorStore` protocol). Make `set` durable if you
  need to survive restarts.
- **Polling.** `poll_interval=None` (default) returns once caught up; a number of
  seconds sleeps and polls forever.
- **Retries.** 429, 5xx and network errors back off exponentially (`Retry-After`
  honored, capped by `backoff_max`); 400/401/403/404 raise typed errors at once.
- **Late-committing rows.** Event ids follow insertion order, not commit order
  ([#2053](https://gitlab.com/visiban/visiban/-/issues/2053)). `overlap=N`
  (default 0, off) re-reads from `cursor - N` and de-duplicates on `id`. It
  narrows the window; it is not gap-free.
- **Auth.** A scoped personal access token, sent only to `base_url`. Redirects
  are never followed, and plain `http://` to a non-loopback host is refused
  unless `allow_insecure=True`.

## Webhook signatures (experimental)

```python
from visiban_client import verify_signature

ok = verify_signature(secret, request.headers, raw_body_bytes)  # False on any failure
```

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
